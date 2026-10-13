# Runtime research for automatic npm update activation

Date: 2026-10-13. Scope: read-only inspection of the current repository and the installed, pinned Pi SDK. This document describes requirements for a future implementation; the current code has no automatic update supervisor or drain protocol.

## Findings from the current implementation

| Area | Current behavior and evidence | Consequence for updates |
| --- | --- | --- |
| Lifecycle | `main.ts:15–19` acquires a process lock, loads state, then constructs runtime components. `main.ts:146–147` waits for parallel bot/initialization/timer loops and releases the lock in `finally`. | A replacement must wait for complete worker exit, not merely a drain acknowledgement or a removed lock file. |
| Stop | `main.ts:37–38` sets `stopped`, starts Pi abort and MTProto disconnect without awaiting either there. | A normal signal currently interrupts work; it is not an update drain. Disconnecting MTProto before an approved send finishes creates an ambiguous result. |
| Bot polling | `main.ts:68–73` saves each offset after handling the update. The already returned batch has no `stopped` check inside its `for`. `bot.ts:12–15,28` gives polling a 40 second request timeout and 25 second long-poll timeout. | Stop admission explicitly at batch boundaries. If an unhandled suffix is left, retain the offset of the processed prefix. Aborting a read is safe; acknowledging and dropping a callback is not. |
| Owner inbox | `main.ts:64`, `store.ts:68–70` persist owner text with a fresh UUID before the bot loop saves its offset. | A crash between those saves can enqueue the same Telegram update twice. Introduce a stable owner inbox id from bot identity and `update_id`, and persist queue acceptance and cursor together. |
| Source checkpoints | Telegram differences enqueue before advancing `pts`/counters (`telegram.ts:109–111,126–127`); mail enqueues before advancing UID (`mail.ts:51–54`); schedule enqueues before persisting token (`calendar/study-calendar.ts:46–51`). `Store.enqueue` uses source id/content hash (`store.ts:55–66`). | Preserve these orderings. Replayed source batches can be deduplicated; cursors must never be advanced over data not durably queued. Do not reset history flags or bootstrap status on update. |
| Agent queue | `main.ts:88–99` selects a queued item, performs Pi turn, sends the final answer, then removes the item and saves. A thrown turn remains queued. | A drain can finish one accepted turn while refusing the next. A killed or aborted turn may have already changed a calendar or notified the owner; leaving the item queued alone is insufficient to guarantee no repeated effects. |
| Tool cancellation | `tools.ts:12–15` ignores the Pi execute call id and signal and awaits the provided function. | SDK abort cannot be assumed to cancel a calendar write or send; active tools must be tracked separately and permitted to settle. |
| Tool side effects | `tools.ts:50–55` serializes task changes with scheduler operations. `tools.ts:67–68` deduplicates a notification with turn id/content hash after sending. | Existing serialization is local to one worker and not a replacement fence. Record durable operation intent/result separately from a model turn for replay safety. |
| Persistence | `store.ts:43–53` serializes snapshots through a promise chain, writes a private temp file, fsyncs it, and renames. There is no public flush barrier, no schema version, and no parent directory fsync. | Expose a flush barrier and distinguish normal process replacement guarantees from power-loss durability. Await all producers before the final snapshot; concurrent new writes after a flush invalidate the handoff checkpoint. |
| Lock | `store.ts:80–91` stores only PID, probes it with `kill(pid,0)`, unlinks a stale file, and creates with `wx`. `cli/service.ts:10–24` uses the same PID file for status. | PID reuse and stale-file unlink races need ownership verification. A supervisor lock and worker ownership have different roles; status must show both. A replacement must not clear another owner's lock. |
| Approvals | `approvals.ts:19–20,36–47` saves exact approved payload, a stable MTProto `randomId`, and `sending` before the request; `recover()` retries `sending`. `inFlight` (`39–48`) is in memory. | Preserve ids and payloads through update/rollback. Do not execute approval recovery in an uncommitted candidate. Existing random-id reuse should be retained, but not described as an unlimited exactly-once guarantee. |
| Calendar writes | Task event ids are deterministic (`calendar/study-calendar.ts:18–23`). CalDAV writes read ETag and use conditional updates/create (`calendar/providers/caldav.ts:122–149`); Google upserts use fixed event id (`calendar/providers/google.ts:46–57`). | Stable resource ids prevent duplicate task events, but do not prevent a stale replay overwriting a later user edit. Resolve a write with an ambiguous response by reading current state, not blindly replaying the entire LLM turn. |
| Startup | `main.ts:128–138` connects services, opens Pi, recovers approved operations and sends a startup message before `ready=true`. `PiAssistant.open` may seed a transcript and saves session path (`pi.ts:71–79`). | This initialization cannot serve as a side-effect-free candidate health probe. Split preparation, exclusive state loading, readiness and activation. |
| Notifications | `scheduler.ts:26–28,43–46`, `approvals.ts:26–29,62–63`, `tools.ts:67–68`, and `main.ts:96–99,116–117` all send before recording success. `bot.ts:20–26` splits messages into chunks and discards returned receipts. | Bot API sendMessage has an unavoidable ambiguous-result window in this code. Graceful drain closes known in-flight windows before switching; crash recovery may repeat a message. An outbox can improve visibility and replay policy, not make the API exactly-once. |
| Reminder catch-up | `scheduler.ts:18–28` groups overdue reminders and sends the latest, with a delayed label when over two minutes late. | Preserve reminder ids and delivery markers. The new worker should reconcile calendar state before delivering overdue reminders. |
| Digests | `scheduler.ts:49–55` schedules only if current Moscow hour is 10 or 20. | An update pause crossing the end of such an hour can miss a digest that was not queued. Specify a bounded catch-up window for today's missed digest, not only hour equality. |
| Service manager | `cli/system-service.ts:29–37` launches the package `bin` directly with `run`, `Restart=on-failure` and a 90 second stop timeout. `bin/hse-harness.mjs:28–30` imports main in the same process; `cli/service.ts:48–49` starts compiled main directly. | All supported launch paths must enter one supervisor. Legacy workers do not acquire the new behavior merely by overwriting files via npm; one explicit first migration restart is required. |

Source line references are repository-relative and were checked against the current working tree. They should be updated after implementation moves modules.

## Pi SDK observations (installed version 1.0.2)

These are implementation observations, not an assumed contract for all future versions:

- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1873–1890`: `abort()` requests cancellation and awaits `waitForIdle()`. Use the supported wait/idle interface for drain; do not replace it with a fixed sleep.
- The same file, `977–1001`: `dispose()` initiates abort and disconnects event listeners. It does not await tool completion and is not a persistence or shutdown barrier. Call it only after the active turn and tools have settled.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:794–812`: persistence writes/append are synchronous and initial transcript creation is delayed until there is a conversation. No fsync appears in this persistence method. Preserve Pi's native JSONL session model, validate the expected session file, and explicitly fsync the existing file at a safe handoff if claiming durable checkpointing. Do not create a new conversation or rewrite entries merely for updating.
- `src/pi.ts:93–96`: aborted or failed turns are deliberately treated as unsuccessful, retaining the work queue item. That is correct for replayability, but operation replay must reconcile already completed effects.

## Recommended invariants

1. Exactly one active worker owns the data directory, Bot API polling, MTProto connection and external mutation admission. A supervisor does not itself process study work. No blue/green pair runs active on the same state or Telegram account.
2. A runnable release is an immutable complete tree, including its bundled dependencies. Never continue serving from the directory npm is overwriting. Keep both current and previous complete release available until the next verified promotion.
3. The supervisor stays in a stable home-owned runtime path, outside npm's replaceable package directory; the active worker also runs from an immutable home-owned release. Lazy Pi imports/resources and compiled module imports must resolve inside that same release.
4. The old worker closes admission before its final checkpoint. Every accepted input is either durably queued with its cursor or fully handled. Every admitted external operation either settles or has a durable, explicit unresolved state.
5. New worker admission remains disabled until the old process exited and new worker has exclusive ownership. Its ready acknowledgement is associated with the supervisor transaction id and worker generation.
6. Update rollback means returning to previous code with the current compatible data, queue, transcript, ids and external operation receipts. Never rewind the data snapshot, Pi transcript, bot offset, delivered map, tokens, approval states or refreshed credentials automatically.
7. Candidate selection and failure reasons are durably recorded outside study operations so supervisor restart can recover a interrupted handoff. An unsuccessful candidate is quarantined rather than retried every detection interval.
8. Ordinary network outage or subscription rate limit is a degraded service state, not proof that the release is defective. Trigger automatic rollback on local initialization/protocol/runtime faults; avoid oscillation between versions due to an unavailable external provider.
9. Configuration paths and provider permissions remain unchanged. An update may not broaden selected Telegram chats or send new group questions without the saved approval.

## Drain protocol required by the specification

Suggested worker phases: `preparing → ready-inactive → active → draining → drained → exited`. The supervisor transaction should distinguish staging, drain requested, old exited, candidate ready, candidate activated and rollback pending. The exact module names may change; the transitions must be testable.

1. Stage and validate the candidate while the old release remains active, without touching live operations, transcript, auth or remote mutation APIs. The global npm manifest is only a trigger/version hint: install that exact registry version into a private immutable release tree, verify its declared integrity and runtime manifest, and do not execute npm-provided lifecycle hooks against live data. Validate runtime compatibility, bundled dependencies, protocol version and state-schema read/write compatibility. Package metadata version alone is insufficient to prove the global installation complete; executing modules directly from that replaceable tree is forbidden. If an offline/local staging source is later supported, require its own complete-content integrity contract.
2. Request drain over an authenticated local IPC channel tied to supervisor/worker generation. Refuse new Pi turns, reminder batches, approval executions and source-poll iterations. Interrupt long polling and idle/retry sleeps through cancellable controllers. Within an already accepted loop, finish only the admitted batch/unit needed to persist its checkpoint, with explicit admission checks between units.
3. Allow the current turn, approval and delivery to settle. Do not disconnect MTProto while its mutation is in flight. Do not replay rejected update callbacks or acknowledge a callback as accepted unless it is actually persisted/handled. Finish a final bot response and its queue deletion together within the tracked drain scope.
4. Await tracked runtime tasks, calendar serialization tail, Pi idle, all transport writes and store flush; save final state and sync the session if applicable. Emit `drained` only when no new work can be admitted and no external mutation is in flight. Keep fencing ownership until worker exits.
5. Stop/dispose resources and let the supervisor observe worker exit. Only then can candidate load/write live state and acquire worker ownership. Candidate startup should reach `ready-inactive` without approval recovery, input polling, calendar mutation, reminders or startup spam. This local boot-ready phase confirms owned state/session/config load and lifecycle initialization; it must not wait for successful access to all remote services. Activation then runs the normal connection/recovery paths and reports provider availability separately.
6. Activation acknowledgement promotes the release. A startup/probation failure uses previous code against the current compatible state, respecting the same single-worker ownership; notifications mention rollback once, when communication recovers if needed.

### Deadline and stuck work policy

Use a configurable bounded drain wait, but do not promise every update completes within that wait. For an ordinary planned update, default on drain timeout should be **defer the update and resume the existing worker**, if its process/runtime remains healthy. Killing a worker at an unknown point in an approved send/calendar mutation solely to meet a deployment deadline is not safe.

An optional force path is operational crash recovery: persist unresolved operations first, request cancellation, and wait for tools to settle where possible. SIGKILL cannot undo remote acceptance. The replacement must surface and reconcile uncertainty. If the old worker cannot be proven gone, neither candidate nor rollback worker may start. The normal external systemd stop timeout must be aligned with this policy, since systemd can kill an entire process group after its own timeout.

Ordinary drain timeout does not call Pi abort: reopen admission and let the accepted model turn finish on the old release. SIGINT/SIGTERM from the user/systemd are a separate shutdown request and may request model/read cancellation; they still must wait for tracked external mutations and persistence before disconnecting/releasing ownership. An explicit stop received during staging or drain cancels update promotion and must not spawn a replacement or rollback worker after the user asked to stop.

### Concrete loop checkpoints and barriers

- **Bot loop:** stop issuing `getUpdates`; cancel an in-flight read only via a read-specific controller. Between updates, check drain admission. An accepted `/tasks`/callback/unit completes, including any send and save. Persist an owner update together with its inbox id and offset; leave a not-yet-admitted suffix for the next poll. `answerCallbackQuery` should correspond to accepted handling rather than hide a discarded approval click.
- **Sources:** no new source provider poll after drain begins. Telegram history/difference processing checks between durably enqueued groups; it need not finish the entire semester history or 100 catch-up iterations. If stopping midway through a difference, do not advance its final counter; saved source hashes make restart replay safe. History-complete flag is set only on completed reconciliation. Mail checks between messages after enqueue plus UID snapshot and closes the current mailbox/client; schedule checks after durable enqueue, and commits its cursor only when its complete result has been accepted. Network reads and retry sleeps should be interruptible without treating a planned drain as a health outage.
- **Agent:** record the accepted item as in flight before prompt, permit its tool chain to finish during ordinary drain, and hold admission closed through final response, outbox receipt and queue removal/save. No next prompt. A timeout cancels the drain request, not the turn. Prompt idle alone is insufficient if post-prompt delivery is still running.
- **Timers:** no new `recover`, approval tick, scheduler transaction or digest enqueue after closing timer admission. Await the active timer iteration or define durable sub-unit checkpoints. Expose the scheduler transaction-tail drain barrier and approvals in-flight barrier. All calls into approvals, including callbacks and initialization, share the same admission/tracker.
- **Startup:** track initialization as an active lifecycle task. During an incomplete old connection/open, do not start a second initialize loop or dispose its Pi session while `open()` can still publish it. Cancelling an update during initialization resumes the original attempt; user stop cancels reads and closes created resources exactly once.
- **Persistence:** after all accepted scopes settled, perform a final state save then `Store.flush()`, session synchronization, transport close, and worker exit. The tracker must include health/update notices, approvals previews, owner responses and auth refreshes, not only tools. Shared controller cancellation is inappropriate for a read and send that use the same Bot API wrapper today.

## Durable operation and delivery requirements

An incremental extension of `operations.json` is sufficient; this is operational persistence, not a new agent memory architecture. Add a versioned outbox/operation ledger and stable input ids only where needed for handoff/recovery. Keep native Pi JSONL memory and `search_history` unchanged.

| Operation | Stable identity and safe recovery | Limit |
| --- | --- | --- |
| Owner input | Bot identity + update id; persist input acceptance and next offset in one snapshot. | Telegram retains input for a finite server period; long downtime is not unlimited recovery. |
| Pi turn | Existing queue id plus persisted turn phase and final response draft; tool operation identity must also include its effect/payload, not only a newly generated model tool call id. | Re-running a model turn may generate different arguments/ids; consult receipts and reconcile before repeating effects. |
| Group question | Existing approval id, exact payload and stable MTProto random id; persist result message id. | Server deduplication behavior is transport-specific; preserve existing semantics and avoid absolute exactly-once claims. |
| Agent task event | Stable task/event id, provider identity, expected state and operation payload hash; read-back reconciliation for ambiguous response. | Same id prevents a second resource, not a stale overwrite of externally edited content. |
| Timetable move | Existing approval id and exact occurrence id; save/read the approved preview version/ETag where supported. If actual current fields differ, stop and ask for renewed approval. | Recovery replay must not silently apply old approval over a new user/provider change. Current Google move lacks ETag preconditions. |
| Personal Bot API notification | Stable semantic delivery id, per-chunk pending/in-flight/sent/ambiguous status and returned message receipt; stage response before queue completion. | Bot API sendMessage offers no client idempotency key in this transport. A response lost after acceptance cannot always be distinguished from non-delivery. |

For reminders whose non-delivery could hide a deadline, adopt explicit at-least-once retry after an ambiguous Bot API result, accepting and documenting possible duplicates. For arbitrary text responses, approval previews and health/update notices, specify the retry policy independently; do not suppress them as “sent” before actual confirmation. Once a chunk has a confirmed receipt persisted, do not send it again. A graceful update must wait through send and receipt persistence, which eliminates update-induced ambiguity on the happy path.

## Rollback compatibility contract

- Introduce an operations schema version and declared readable/writable ranges per release. Treat today's unversioned state as a named legacy version.
- Compatibility checks also cover Pi SDK transcript version, Pi model/auth stores, user config and secrets formats, not only `operations.json`.
- Normal auto-activation requires candidate and previous release to read/write the live format throughout probation. Prefer additive optional fields; consumers must retain unknown fields on save. Migration that rewrites/removes fields or upgrades Pi JSONL incompatibly must disable automatic rollback/activation until a separate planned migration is approved and tested.
- A filesystem backup is useful for disaster recovery, but its automatic restoration after remote operations would forget external sends, delivered markers and source progress. It is not the rollback algorithm.
- If candidate crashes after activation and emitted a remote operation, previous code must still interpret its ledger/outbox entries; otherwise automatic rollback is not permitted.
- First installation of supervisor support requires stopping/restarting the existing 0.1.0 worker once. Future compatible npm updates may be activated automatically. A package rewrite cannot retrofit a supervisor into an already running process.

## Verification required before declaring the mode working

Existing tests validate normal restart, pinned Pi memory recovery, delayed reminders and selected transport recovery (`test/e2e/run.mjs:212–257`, `test/core.test.ts:32–100`). They do not exercise replacing a package tree or a drain handshake and are not evidence for the new mode.

Required additions using real compiled, installed A/B release fixtures:

1. Update during Bot API long poll, midway through returned batch, and between owner enqueue and offset persistence: one durable inbox item per update; an unread suffix is recovered.
2. Update during model response and compaction, after a tool commits calendar state but before turn queue deletion, and during a final multi-chunk response: native Pi session is reopened, completed effects are not blindly repeated, unresolved phases remain visible.
3. Drain during an approved MTProto send, including accepted request with response loss: same saved random id and one recovery policy; no second active worker.
4. Drain during CalDAV PUT/PATCH/delete and Google write, including response loss and a concurrent external edit: fixed event id, read-back reconciliation, renewed approval on stale timetable preview.
5. Update while a reminder/urgent notice/digest is due; pause crosses Moscow hour boundary: overdue reminder policy and bounded digest catch-up are deterministic, completed deliveries retained.
6. Drain timeout and a hung custom tool: ordinary update defers without SIGKILL; old worker resumes or service enters a visible blocked/recovery state; no candidate starts over a possibly live owner.
7. Candidate invalid module/dependency/schema/Node version, startup crash, readiness timeout and post-activation crash: A remains or returns on current state; no history reset, state rewind or retry loop.
8. Supervisor crash before drain, after old exit, before promotion, after activation and during rollback; reboot with stale/partial locks and PID reuse: state machine recovers without concurrent workers.
9. Partial npm install, failed npm update, simultaneous npm commands and deletion of installed package: A continues from immutable tree; candidate accepted only when staging verifies complete content.
10. Source/CLI/systemd launch parity and process-group termination: supervisor receives systemd signals, bounded normal stop works, foreground Ctrl+C leaves no orphan worker, status identifies the right generation.
11. A genuinely breaking schema/Pi SDK release: compatibility gate blocks auto-activation before any live state modification; a backup is never silently restored to bypass it.

## Minimal source change boundaries

- Extract `main()` into a testable runtime lifecycle that owns admission, active task tracking, phases and orderly close; retain a thin worker entry point.
- Add supervisor/release-store/protocol modules outside study-domain classes. Route package foreground `start`, `run` and systemd through the supervisor, including the source workflow if advertised as supported.
- Add `Store.flush`, schema/compatibility checks and ownership-safe locks; expose scheduler/approval in-flight barriers rather than introspecting private promises/sets.
- Thread cancellation into read polling and sleeps; mutation APIs need settlement tracking and ambiguity handling rather than abort-only shutdown.
- Introduce stable owner inbox ids and limited operation/outbox persistence; return Telegram Bot API message receipts and persist chunk outcomes.
- Split worker startup preparation/readiness/activation so pre-activation checks never run approval recovery or send startup messages.
- Add update-aware status, quarantine/defer reasons, compatibility and delayed reminder/digest reporting. Keep secrets and private study data out of package verification logs and release snapshots.
