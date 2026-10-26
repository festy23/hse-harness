# Карта покрытия исходников

Карта связывает исходники ревизии `f3bacd3` с контрактами текущего поведения.
Декларации типов относятся к тем же операциям, что и соответствующая реализация.
Каждый файл исполняемого приложения, runtime, CLI, scripts, deploy и CI должен иметь запись.

| Исходный файл | Контракт |
|---|---|
| [.env.example](../../.env.example) | [core/settings](core/settings.md), [sources/settings](sources/settings.md), [telegram-bot/settings](telegram-bot/settings.md), [calendar/settings](calendar/settings.md), [assistant/settings](assistant/settings.md) |
| [.github/workflows/ci.yml](../../.github/workflows/ci.yml) | [development / job / ci](development/jobs/ci.md) |
| [.oxfmtrc.json](../../.oxfmtrc.json) | [development / quality](development/operations/quality.md) |
| [.oxlintrc.json](../../.oxlintrc.json) | [development / quality](development/operations/quality.md) |
| [bin/hse-harness.mjs](../../bin/hse-harness.mjs) | [runtime / installation](runtime/operations/installation.md), [cli / commands](cli/operations/commands.md) |
| [config.example.json](../../config.example.json) | [core/settings](core/settings.md), [sources/settings](sources/settings.md), [telegram-bot/settings](telegram-bot/settings.md), [calendar/settings](calendar/settings.md), [assistant/settings](assistant/settings.md) |
| [deploy/icloud-compat.mjs](../../deploy/icloud-compat.mjs) | [development / compatibility](development/operations/compatibility.md) |
| [deploy/imap-errors-compat.mjs](../../deploy/imap-errors-compat.mjs) | [development / compatibility](development/operations/compatibility.md) |
| [deploy/study-assistant.service](../../deploy/study-assistant.service) | [development / compatibility](development/operations/compatibility.md) |
| [deploy/telegram-wss-compat.mjs](../../deploy/telegram-wss-compat.mjs) | [development / compatibility](development/operations/compatibility.md) |
| [hse](../../hse) | [development / harness](development/operations/harness.md) |
| [package-lock.json](../../package-lock.json) | [development / package](development/operations/package.md) |
| [package.json](../../package.json) | [development / package](development/operations/package.md) |
| [runtime/executable.mjs](../../runtime/executable.mjs) | [runtime / installation](runtime/operations/installation.md) |
| [runtime/installation.d.mts](../../runtime/installation.d.mts) | [runtime / installation](runtime/operations/installation.md), [runtime/database/README](runtime/database/README.md) |
| [runtime/installation.mjs](../../runtime/installation.mjs) | [runtime / installation](runtime/operations/installation.md) |
| [runtime/manifest.mjs](../../runtime/manifest.mjs) | [runtime / manifest](runtime/operations/manifest.md) |
| [runtime/npm-update.d.mts](../../runtime/npm-update.d.mts) | [runtime / npm-install](runtime/operations/npm-install.md) |
| [runtime/npm-update.mjs](../../runtime/npm-update.mjs) | [runtime / npm-install](runtime/operations/npm-install.md) |
| [runtime/releases.mjs](../../runtime/releases.mjs) | [runtime / releases](runtime/operations/releases.md), [runtime / HTTP / version](runtime/http/version.md), [runtime / HTTP / archive](runtime/http/archive.md) |
| [runtime/storage.mjs](../../runtime/storage.mjs) | [runtime / storage](runtime/operations/storage.md), [runtime/database/README](runtime/database/README.md) |
| [runtime/supervisor.mjs](../../runtime/supervisor.mjs) | [runtime / ipc](runtime/operations/ipc.md), [runtime / switch](runtime/operations/switch.md), [runtime / job / supervisor](runtime/jobs/supervisor.md) |
| [scripts/benchmark-async.mjs](../../scripts/benchmark-async.mjs) | [development / diagnostics](development/operations/diagnostics.md) |
| [scripts/code-policy.mjs](../../scripts/code-policy.mjs) | [development / quality](development/operations/quality.md) |
| [scripts/create-runtime-manifest.mjs](../../scripts/create-runtime-manifest.mjs) | [development / package](development/operations/package.md) |
| [scripts/harness.mjs](../../scripts/harness.mjs) | [development / harness](development/operations/harness.md) |
| [scripts/prepare-bundle.mjs](../../scripts/prepare-bundle.mjs) | [development / package](development/operations/package.md) |
| [scripts/process.d.mts](../../scripts/process.d.mts) | [cli / process](cli/operations/process.md) |
| [scripts/process.mjs](../../scripts/process.mjs) | [cli / process](cli/operations/process.md) |
| [scripts/python-code-policy.py](../../scripts/python-code-policy.py) | [development / quality](development/operations/quality.md) |
| [scripts/record-cli-demo.py](../../scripts/record-cli-demo.py) | [development / diagnostics](development/operations/diagnostics.md) |
| [scripts/verify-package.mjs](../../scripts/verify-package.mjs) | [development / package](development/operations/package.md) |
| [src/approvals.ts](../../src/approvals.ts) | [study / propose-approval](study/operations/propose-approval.md), [study / decide-approval](study/operations/decide-approval.md), [study / job / approvals](study/jobs/approvals.md) |
| [src/bot-commands.ts](../../src/bot-commands.ts) | [telegram-bot / commands](telegram-bot/operations/commands.md) |
| [src/bot.ts](../../src/bot.ts) | [telegram-bot / transport](telegram-bot/operations/transport.md), [telegram-bot / send](telegram-bot/operations/send.md), [telegram-bot / HTTP / get-updates](telegram-bot/http/get-updates.md), [telegram-bot / HTTP / send-message](telegram-bot/http/send-message.md), [telegram-bot / HTTP / answer-callback-query](telegram-bot/http/answer-callback-query.md) |
| [src/calendar/collection.ts](../../src/calendar/collection.ts) | [calendar / collections](calendar/operations/collections.md) |
| [src/calendar/compute.ts](../../src/calendar/compute.ts) | [calendar / icalendar](calendar/operations/icalendar.md) |
| [src/calendar/http.ts](../../src/calendar/http.ts) | [calendar / HTTP / google-request](calendar/http/google-request.md), [calendar / HTTP / caldav-discovery](calendar/http/caldav-discovery.md) |
| [src/calendar/index.ts](../../src/calendar/index.ts) | [calendar / collections](calendar/operations/collections.md) |
| [src/calendar/providers/caldav.ts](../../src/calendar/providers/caldav.ts) | [calendar / collections](calendar/operations/collections.md), [calendar / HTTP / caldav-discovery](calendar/http/caldav-discovery.md), [calendar / HTTP / caldav-report](calendar/http/caldav-report.md), [calendar / HTTP / caldav-put](calendar/http/caldav-put.md), [calendar / HTTP / caldav-delete](calendar/http/caldav-delete.md) |
| [src/calendar/providers/google.ts](../../src/calendar/providers/google.ts) | [calendar / google-mapping](calendar/operations/google-mapping.md), [calendar / HTTP / google-events-list](calendar/http/google-events-list.md), [calendar / HTTP / google-events-get](calendar/http/google-events-get.md), [calendar / HTTP / google-events-post](calendar/http/google-events-post.md), [calendar / HTTP / google-events-put](calendar/http/google-events-put.md), [calendar / HTTP / google-events-patch](calendar/http/google-events-patch.md), [calendar / HTTP / google-events-delete](calendar/http/google-events-delete.md) |
| [src/calendar/providers/icloud.ts](../../src/calendar/providers/icloud.ts) | [calendar / collections](calendar/operations/collections.md), [calendar / HTTP / caldav-discovery](calendar/http/caldav-discovery.md) |
| [src/calendar/providers/yandex.ts](../../src/calendar/providers/yandex.ts) | [calendar / collections](calendar/operations/collections.md), [calendar / HTTP / caldav-discovery](calendar/http/caldav-discovery.md) |
| [src/calendar/study-calendar.ts](../../src/calendar/study-calendar.ts) | [calendar / study-calendar](calendar/operations/study-calendar.md), [calendar / job / sync-schedule](calendar/jobs/sync-schedule.md) |
| [src/cli.ts](../../src/cli.ts) | [cli / commands](cli/operations/commands.md) |
| [src/cli/application.ts](../../src/cli/application.ts) | [cli / commands](cli/operations/commands.md) |
| [src/cli/brand.ts](../../src/cli/brand.ts) | [cli / terminal](cli/operations/terminal.md) |
| [src/cli/connections/calendars.ts](../../src/cli/connections/calendars.ts) | [cli / connections](cli/operations/connections.md), [cli / HTTP / google-calendar-list](cli/http/google-calendar-list.md) |
| [src/cli/connections/google-auth.ts](../../src/cli/connections/google-auth.ts) | [cli / google-auth](cli/operations/google-auth.md), [cli / HTTP / google-callback](cli/http/google-callback.md), [cli / HTTP / google-authorize](cli/http/google-authorize.md), [cli / HTTP / google-token](cli/http/google-token.md) |
| [src/cli/connections/index.ts](../../src/cli/connections/index.ts) | [cli / connections](cli/operations/connections.md) |
| [src/cli/connections/mail.ts](../../src/cli/connections/mail.ts) | [cli / connections](cli/operations/connections.md) |
| [src/cli/connections/pi.ts](../../src/cli/connections/pi.ts) | [cli / connections](cli/operations/connections.md) |
| [src/cli/connections/telegram.ts](../../src/cli/connections/telegram.ts) | [cli / connections](cli/operations/connections.md), [cli / HTTP / bot-get-me](cli/http/bot-get-me.md) |
| [src/cli/errors.ts](../../src/cli/errors.ts) | [cli / terminal](cli/operations/terminal.md) |
| [src/cli/icons.ts](../../src/cli/icons.ts) | [cli / terminal](cli/operations/terminal.md) |
| [src/cli/import-installation.ts](../../src/cli/import-installation.ts) | [cli / import](cli/operations/import.md) |
| [src/cli/onboarding.ts](../../src/cli/onboarding.ts) | [cli / setup-state](cli/operations/setup-state.md), [cli / sections](cli/operations/sections.md) |
| [src/cli/ports.ts](../../src/cli/ports.ts) | [cli / setup-state](cli/operations/setup-state.md), [cli/settings](cli/settings.md), [cli / terminal](cli/operations/terminal.md), [cli / connections](cli/operations/connections.md) |
| [src/cli/progress.ts](../../src/cli/progress.ts) | [cli / terminal](cli/operations/terminal.md) |
| [src/cli/service.ts](../../src/cli/service.ts) | [cli / process](cli/operations/process.md) |
| [src/cli/state.ts](../../src/cli/state.ts) | [cli / setup-state](cli/operations/setup-state.md), [cli/database/README](cli/database/README.md) |
| [src/cli/status.ts](../../src/cli/status.ts) | [cli / status](cli/operations/status.md) |
| [src/cli/steps/calendars.ts](../../src/cli/steps/calendars.ts) | [cli / sections](cli/operations/sections.md) |
| [src/cli/steps/context.ts](../../src/cli/steps/context.ts) | [cli / sections](cli/operations/sections.md) |
| [src/cli/steps/mail.ts](../../src/cli/steps/mail.ts) | [cli / sections](cli/operations/sections.md) |
| [src/cli/steps/model.ts](../../src/cli/steps/model.ts) | [cli / sections](cli/operations/sections.md) |
| [src/cli/steps/profile.ts](../../src/cli/steps/profile.ts) | [cli / sections](cli/operations/sections.md) |
| [src/cli/steps/telegram.ts](../../src/cli/steps/telegram.ts) | [cli / sections](cli/operations/sections.md) |
| [src/cli/system-service.ts](../../src/cli/system-service.ts) | [cli / service](cli/operations/service.md) |
| [src/cli/telegram-access.ts](../../src/cli/telegram-access.ts) | [cli / connections](cli/operations/connections.md), [cli / status](cli/operations/status.md) |
| [src/cli/terminal.ts](../../src/cli/terminal.ts) | [cli / terminal](cli/operations/terminal.md) |
| [src/cli/updates.ts](../../src/cli/updates.ts) | [cli / updates](cli/operations/updates.md) |
| [src/compute/client.ts](../../src/compute/client.ts) | [core / compute](core/operations/compute.md), [calendar / icalendar](calendar/operations/icalendar.md) |
| [src/compute/html.ts](../../src/compute/html.ts) | [core / compute](core/operations/compute.md), [calendar / icalendar](calendar/operations/icalendar.md) |
| [src/compute/index.ts](../../src/compute/index.ts) | [core / compute](core/operations/compute.md), [calendar / icalendar](calendar/operations/icalendar.md) |
| [src/compute/jobs.ts](../../src/compute/jobs.ts) | [core / compute](core/operations/compute.md), [calendar / icalendar](calendar/operations/icalendar.md) |
| [src/compute/worker.ts](../../src/compute/worker.ts) | [core / compute](core/operations/compute.md), [calendar / icalendar](calendar/operations/icalendar.md) |
| [src/config-file.ts](../../src/config-file.ts) | [core / locking](core/operations/locking.md) |
| [src/config.ts](../../src/config.ts) | [core / configuration](core/operations/configuration.md), [core/settings](core/settings.md) |
| [src/domain.ts](../../src/domain.ts) | [core / domain](core/operations/domain.md), [core/database/README](core/database/README.md) |
| [src/evaluate.ts](../../src/evaluate.ts) | [development / evaluation](development/operations/evaluation.md) |
| [src/google.ts](../../src/google.ts) | [calendar / HTTP / google-request](calendar/http/google-request.md), [calendar / HTTP / google-oauth](calendar/http/google-oauth.md) |
| [src/imap-session.ts](../../src/imap-session.ts) | [sources / imap-session](sources/operations/imap-session.md) |
| [src/mail.ts](../../src/mail.ts) | [sources / job / mail-poll](sources/jobs/mail-poll.md), [sources / mail-text](sources/operations/mail-text.md) |
| [src/main.ts](../../src/main.ts) | [core / job / worker](core/jobs/worker.md), [telegram-bot / job / polling](telegram-bot/jobs/polling.md), [assistant / job / agent-turn](assistant/jobs/agent-turn.md) |
| [src/onboarding.ts](../../src/onboarding.ts) | [cli / setup-state](cli/operations/setup-state.md), [cli / commands](cli/operations/commands.md) |
| [src/operations.ts](../../src/operations.ts) | [core / budgets](core/operations/budgets.md) |
| [src/pi.ts](../../src/pi.ts) | [assistant / session](assistant/operations/session.md), [assistant / turn](assistant/operations/turn.md), [assistant / HTTP / read-hse](assistant/http/read-hse.md), [assistant / HTTP / subscription-models](assistant/http/subscription-models.md) |
| [src/scheduler.ts](../../src/scheduler.ts) | [study / scheduler](study/operations/scheduler.md), [study / job / reminders](study/jobs/reminders.md), [study / job / digests](study/jobs/digests.md) |
| [src/setup.ts](../../src/setup.ts) | [cli / commands](cli/operations/commands.md) |
| [src/store.ts](../../src/store.ts) | [core/database/README](core/database/README.md), [core / persistence](core/operations/persistence.md), [core / ingestion](core/operations/ingestion.md), [core / locking](core/operations/locking.md) |
| [src/telegram-chats.ts](../../src/telegram-chats.ts) | [sources / chats](sources/operations/chats.md) |
| [src/telegram-client.ts](../../src/telegram-client.ts) | [sources / connect-telegram](sources/operations/connect-telegram.md) |
| [src/telegram-transport.ts](../../src/telegram-transport.ts) | [sources / telegram-rpc](sources/operations/telegram-rpc.md), [sources / telegram-pages](sources/operations/telegram-pages.md) |
| [src/telegram.ts](../../src/telegram.ts) | [sources / connect-telegram](sources/operations/connect-telegram.md), [sources / telegram-sources](sources/operations/telegram-sources.md), [sources / reconcile](sources/operations/reconcile.md), [sources / difference](sources/operations/difference.md), [sources / history-question](sources/operations/history-question.md), [sources / job / telegram-poll](sources/jobs/telegram-poll.md) |
| [src/tools.ts](../../src/tools.ts) | [assistant / tools](assistant/operations/tools.md) |
| [src/updates/releases.ts](../../src/updates/releases.ts) | [runtime / HTTP / latest](runtime/http/latest.md), [runtime / manifest](runtime/operations/manifest.md) |
| [src/updates/runtime.ts](../../src/updates/runtime.ts) | [runtime / telegram-updates](runtime/operations/telegram-updates.md), [runtime / job / telegram-updates](runtime/jobs/telegram-updates.md), [runtime / npm-install](runtime/operations/npm-install.md) |
| [src/updates/telegram.ts](../../src/updates/telegram.ts) | [runtime / telegram-updates](runtime/operations/telegram-updates.md), [runtime / job / telegram-updates](runtime/jobs/telegram-updates.md) |
| [src/validation.ts](../../src/validation.ts) | [core / configuration](core/operations/configuration.md), [core/settings](core/settings.md) |
| [src/worker/commands.ts](../../src/worker/commands.ts) | [telegram-bot / coordinator](telegram-bot/operations/coordinator.md) |
| [src/worker/lifecycle.ts](../../src/worker/lifecycle.ts) | [core / worker-control](core/operations/worker-control.md) |
| [src/worker/observability.ts](../../src/worker/observability.ts) | [core / job / worker](core/jobs/worker.md), [core/caches](core/caches.md) |
| [src/worker/task-operations.ts](../../src/worker/task-operations.ts) | [study / task-operation](study/operations/task-operation.md), [study / job / recover-tasks](study/jobs/recover-tasks.md) |
| [tsconfig.check.json](../../tsconfig.check.json) | [development / quality](development/operations/quality.md) |
| [tsconfig.json](../../tsconfig.json) | [development / quality](development/operations/quality.md) |

## Границы карты

`test/` содержит проверки реализации; их команды и место в CI определены в
[Development](development/README.md). Тестовые fixtures не задают дополнительную продуктовую бизнес-логику.
`docs/research`, прежние отчёты аудита и архитектурные предложения не заменяют эти контракты.
`.agents/skills` и `AGENTS.md` управляют работой разработчиков; они не загружаются встроенным Pi-агентом.
Сгенерированные `dist/`, dependency trees и npm tarballs должны соответствовать
[правилам сборки](development/operations/package.md), а не иметь отдельные копии спецификаций.
