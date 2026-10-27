import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { Api, type TelegramClient } from 'teleproto';
import { invoke as sdkInvoke } from 'teleproto/client/users.js';
import bigInt from 'big-integer';
import { ImapFlow } from 'imapflow';
import { TelegramSource } from '../src/telegram.js';
import { telegramInvoke, telegramDialogs } from '../src/telegram-transport.js';
import { MailSource } from '../src/mail.js';
import { GoogleCollection } from '../src/calendar/providers/google.js';
import { StudyCalendar } from '../src/calendar/study-calendar.js';
import { createCalendar } from '../src/calendar/index.js';
import { limitedResponse } from '../src/calendar/http.js';
import { iCloudFetch } from '../src/calendar/providers/icloud.js';
import { createOperation, OperationError } from '../src/operations.js';
import { normalizeSetupConfig } from '../src/cli/state.js';
import {
  telegram as setupTelegram,
  type TelegramSetupClient,
} from '../src/cli/connections/telegram.js';
import { Store } from '../src/store.js';
import type { Source } from '../src/domain.js';
import type { CalendarCollection } from '../src/calendar/collection.js';
import type { SetupUI } from '../src/cli/ports.js';
import type { OperationContext } from '../src/operations.js';
import type { Google } from '../src/google.js';

const group = new Api.Chat({
  id: bigInt(4321),
  title: 'Fixture group',
  photo: new Api.ChatPhotoEmpty(),
  participantsCount: 2,
  date: 1791800000,
  version: 1,
});
const state = () =>
  new Api.updates.State({ pts: 1, qts: 0, date: 1791800000, seq: 1, unreadCount: 0 });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function memoryStore() {
  const store = new Store('unused');
  store.save = async () => {};
  store.enqueue = async (sources: Source[]) => {
    store.state.queue.push({ id: String(store.state.queue.length), sources });
    for (const source of sources) {
      store.state.seen[source.id] = 'fixture';
    }
  };
  return store;
}
function emptyCollection(identity: string): CalendarCollection {
  return {
    identity,
    list: async () => [],
    range: async () => [],
    changes: async () => ({ events: [], full: true }),
    get: async () => {
      throw Error('Unexpected lookup');
    },
    put: async () => {
      throw Error('Unexpected write');
    },
    remove: async () => {
      throw Error('Unexpected removal');
    },
    move: async () => {
      throw Error('Unexpected move');
    },
  };
}
function setupUI(overrides: Partial<SetupUI>): SetupUI {
  return {
    note() {},
    input: async () => {
      throw Error('Unexpected input');
    },
    choose: async () => {
      throw Error('Unexpected choice');
    },
    many: async () => {
      throw Error('Unexpected multiple choice');
    },
    yes: async () => {
      throw Error('Unexpected confirmation');
    },
    task: async (_label, run) => run(),
    ...overrides,
  };
}
type WireResult =
  | Api.updates.State
  | Api.messages.Dialogs
  | Api.messages.Messages
  | Api.updates.TypeDifference
  | Api.updates.TypeChannelDifference
  | Api.UpdateShortSentMessage;

class Wire {
  connected = false;
  destroyed = 0;
  connects = 0;
  gate?: ReturnType<typeof deferred<void>>;
  authError = false;
  requests: Api.AnyRequest[] = [];
  pages: number[] = [];
  items: Api.Message[] = [];
  sendIds: string[] = [];
  ambiguousSend = false;
  updateManager = { stop() {} };
  async connect() {
    this.connects++;
    if (this.gate) {
      await this.gate.promise;
    }
    this.connected = true;
  }
  async destroy() {
    this.destroyed++;
    this.connected = false;
    this.gate?.reject(Error('fixture closed'));
  }
  async disconnect() {
    await this.destroy();
  }
  async invoke(
    request: Api.AnyRequest,
    _dc?: number,
    opts?: Api.ApiCallOptions,
  ): Promise<WireResult> {
    assert.ok(opts?.abortSignal);
    assert.ok(opts.timeout! > 0);
    this.requests.push(request);
    if (request instanceof Api.updates.GetState) {
      if (this.authError) {
        throw Object.assign(Error('fixture auth'), { code: 401 });
      }
      return state();
    }
    if (request instanceof Api.messages.GetDialogs) {
      return new Api.messages.Dialogs({
        dialogs: [
          new Api.Dialog({
            peer: new Api.PeerChat({ chatId: group.id }),
            topMessage: 1,
            readInboxMaxId: 0,
            readOutboxMaxId: 0,
            unreadCount: 0,
            unreadMentionsCount: 0,
            unreadReactionsCount: 0,
            unreadPollVotesCount: 0,
            notifySettings: new Api.PeerNotifySettings({}),
          }),
        ],
        chats: [group],
        users: [],
        messages: [],
      });
    }
    if (request instanceof Api.messages.GetHistory) {
      this.pages.push(request.offsetId);
      return new Api.messages.Messages({
        topics: [],
        messages: this.items
          .filter((m) => !request.offsetId || m.id < request.offsetId)
          .slice(0, request.limit),
        chats: [],
        users: [],
      });
    }
    if (request instanceof Api.updates.GetDifference) {
      return new Api.updates.DifferenceEmpty({ date: 1791800000, seq: 1 });
    }
    if (request instanceof Api.messages.SendMessage) {
      assert.ok(request.randomId);
      this.sendIds.push(request.randomId.toString());
      if (this.ambiguousSend) {
        this.ambiguousSend = false;
        return new Promise<never>((_, reject) => {
          opts.abortSignal!.addEventListener('abort', () => reject(opts.abortSignal!.reason), {
            once: true,
          });
        });
      }
      return new Api.UpdateShortSentMessage({ id: 37, pts: 1, ptsCount: 1, date: 1791800000 });
    }
    throw Error('Unexpected fixture request ' + request.className);
  }
  get client() {
    return this as unknown as TelegramClient;
  }
}
async function fixture(
  run: (
    source: TelegramSource,
    wires: Wire[],
    store: Store,
    root: string,
    setContinue: (v: boolean) => void,
    setTime: (v: number) => void,
  ) => Promise<void>,
  count = 1,
  alert: (text: string, deliveryId?: string) => Promise<void> = async () => {},
) {
  const root = await mkdtemp(join(tmpdir(), 'integration-budgets-')),
    old = process.env.STUDY_SECRETS_DIR;
  process.env.STUDY_SECRETS_DIR = join(root, 'secrets');
  await mkdir(join(root, 'secrets'));
  await writeFile(join(root, 'secrets/telegram.session'), 'fixture');
  const wires = Array.from({ length: count }, () => new Wire()),
    store = memoryStore();
  let index = 0,
    continuing = true,
    time = 0;
  const config = normalizeSetupConfig({
    ownerId: 42,
    model: 'fixture',
    chats: [{ id: '-4321', title: 'Fixture group', allowQuestions: true }],
  });
  const source = new TelegramSource(
    config,
    store,
    async () => {},
    alert,
    () => continuing,
    { createClient: () => wires[index++]!.client, now: () => time },
  );
  try {
    await run(
      source,
      wires,
      store,
      root,
      (v) => {
        continuing = v;
      },
      (v) => {
        time = v;
      },
    );
  } finally {
    await source.close();
    old === undefined
      ? delete process.env.STUDY_SECRETS_DIR
      : (process.env.STUDY_SECRETS_DIR = old);
    await rm(root, { recursive: true, force: true });
  }
}

test('bounded raw RPC cancels actual pinned SDK request state', async () => {
  let cancelled = 0,
    queued = false;
  const sender = {
    userDisconnected: false,
    addStateToQueue() {
      queued = true;
    },
    cancelRequest(s: { reject: (error: unknown) => void }, error: unknown) {
      cancelled++;
      s.reject(error);
    },
  };
  const wire = {
    updates: { authorizationError: undefined },
    _sender: sender,
    _connectedDeferred: { promise: Promise.resolve() },
    invoke(request: Api.AnyRequest, _dc?: number, options?: Api.ApiCallOptions) {
      return sdkInvoke(this as unknown as TelegramClient, request, undefined, undefined, options);
    },
  };
  const ctx = createOperation('tool', 20),
    keeper = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      telegramInvoke(wire as unknown as TelegramClient, new Api.updates.GetState(), ctx),
      (e) => e instanceof OperationError && e.kind === 'deadline',
    );
    assert.ok(queued);
    assert.equal(cancelled, 1);
  } finally {
    ctx.dispose();
    clearTimeout(keeper);
  }
});

test('native dialog pagination advances offsets, excludes pinned repeats and deduplicates peers', async () => {
  const chats = Array.from(
    { length: 101 },
    (_, i) => new Api.Chat({ ...group, id: bigInt(i + 1) }),
  );
  let calls = 0;
  const dialog = (id: number) =>
    new Api.Dialog({
      peer: new Api.PeerChat({ chatId: bigInt(id) }),
      topMessage: id,
      readInboxMaxId: 0,
      readOutboxMaxId: 0,
      unreadCount: 0,
      unreadMentionsCount: 0,
      unreadReactionsCount: 0,
      unreadPollVotesCount: 0,
      notifySettings: new Api.PeerNotifySettings({}),
    });
  const client = {
    async invoke(request: Api.messages.GetDialogs, _dc?: number, options?: Api.ApiCallOptions) {
      assert.ok(options?.abortSignal);
      if (++calls === 1) {
        assert.equal(request.offsetId, 0);
        assert.equal(request.excludePinned, false);
        return new Api.messages.DialogsSlice({
          count: 101,
          dialogs: Array.from({ length: 100 }, (_, i) => dialog(i + 1)),
          chats: chats.slice(0, 100),
          users: [],
          messages: [],
        });
      }
      assert.equal(request.offsetId, 100);
      assert.equal(request.excludePinned, true);
      return new Api.messages.Dialogs({
        dialogs: [dialog(1), dialog(101)],
        chats: [chats[0]!, chats[100]!],
        users: [],
        messages: [],
      });
    },
  } as unknown as TelegramClient;
  const dialogs = await telegramDialogs(client);
  assert.equal(calls, 2);
  assert.equal(dialogs.length, 101);
  assert.equal(new Set(dialogs.map((d) => d.id)).size, 101);
});

test('flood wait defers matching RPCs without sleeping or blocking other method types', async () => {
  let requests = 0;
  const client = {
    async invoke(request: Api.AnyRequest) {
      requests++;
      if (request instanceof Api.updates.GetState) {
        throw Object.assign(Error('fixture flood'), { seconds: 60 });
      }
      return new Api.updates.DifferenceEmpty({ date: 1, seq: 1 });
    },
  } as unknown as TelegramClient;
  await assert.rejects(
    telegramInvoke(client, new Api.updates.GetState()),
    (e) => e instanceof OperationError && e.kind === 'rate-limit',
  );
  await assert.rejects(
    telegramInvoke(client, new Api.updates.GetState()),
    (e) => e instanceof OperationError && e.kind === 'rate-limit',
  );
  assert.equal(requests, 1);
  await telegramInvoke(client, new Api.updates.GetDifference({ pts: 1, qts: 0, date: 1 }));
  assert.equal(requests, 2);
});

test('draining source waiter does not cancel connection still owned by a tool', () =>
  fixture(async (source, [wire]) => {
    wire!.gate = deferred<void>();
    const sourceCtx = createOperation('source', 1000),
      toolCtx = createOperation('tool', 1000);
    const first = source.connect(sourceCtx),
      second = source.connect(toolCtx);
    while (!wire!.connects) {
      await pause(1);
    }
    sourceCtx.abort(new OperationError('cancelled', 'fixture drain', 'drain'));
    await assert.rejects(first, /fixture drain/);
    assert.equal(wire!.destroyed, 0);
    wire!.gate.resolve();
    await second;
    assert.equal(wire!.connects, 1);
    assert.equal(wire!.connected, true);
    sourceCtx.dispose();
    toolCtx.dispose();
  }));

test('one timed-out connection waiter leaves another caller alive', () =>
  fixture(async (source, [wire]) => {
    wire!.gate = deferred<void>();
    const short = createOperation('tool', 25),
      long = createOperation('tool', 1000),
      keeper = setTimeout(() => {}, 1000);
    const first = source.connect(short),
      second = source.connect(long);
    await assert.rejects(first, (e) => e instanceof OperationError && e.kind === 'deadline');
    assert.equal(wire!.destroyed, 0);
    wire!.gate.resolve();
    await second;
    assert.equal(wire!.connects, 1);
    clearTimeout(keeper);
    short.dispose();
    long.dispose();
  }));

test('last cancelled connection waiter joins socket disposal and cannot publish late peers', () =>
  fixture(async (source, [wire]) => {
    wire!.gate = deferred<void>();
    const ctx = createOperation('source', 1000),
      pending = source.connect(ctx);
    while (!wire!.connects) {
      await pause(1);
    }
    ctx.abort(new OperationError('cancelled', 'fixture stop', 'stop'));
    await assert.rejects(pending, /fixture stop/);
    assert.equal(wire!.destroyed, 1);
    assert.equal(source.listChats()[0]!.connected, false);
    assert.equal(wire!.requests.length, 0);
    ctx.dispose();
  }));

test('terminal Telegram sender is replaced without losing durable counters', () =>
  fixture(async (source, [first, second], store) => {
    await source.connect();
    store.state.cursors.tgState = JSON.stringify(state());
    store.state.cursors['tgHistory:-4321'] = '1';
    first!.connected = false;
    const result = await source.poll();
    assert.equal(result.complete, true);
    assert.equal(first!.destroyed, 1);
    assert.equal(second!.connects, 1);
    assert.equal(store.state.cursors['tgHistory:-4321'], '1');
  }, 2));

test('authentication failure suppresses network attempts until session changes', () =>
  fixture(async (source, [first, second], _store, root, _continue, time) => {
    first!.authError = true;
    await assert.rejects(
      source.connect(),
      (e) => e instanceof OperationError && e.kind === 'authentication',
    );
    time(10_000);
    await assert.rejects(
      source.connect(),
      (e) => e instanceof OperationError && e.kind === 'authentication',
    );
    assert.equal(first!.connects, 1);
    assert.equal(second!.connects, 0);
    await writeFile(join(root, 'secrets/telegram.session'), 'replacement-fixture');
    time(100_000);
    await source.connect();
    assert.equal(second!.connects, 1);
  }, 2));

test('history work slices resume from committed offsets and defer deletion reconciliation', () =>
  fixture(async (source, [wire], store, _root, continuing) => {
    wire!.items = Array.from(
      { length: 250 },
      (_, i) =>
        new Api.Message({
          id: 250 - i,
          date: 1791800000,
          message: 'Fixture ' + i,
          peerId: new Api.PeerChat({ chatId: group.id }),
        }),
    );
    store.state.seen['tg:-4321:999'] = 'previous';
    const enqueue = store.enqueue.bind(store);
    store.enqueue = async (sources) => {
      await enqueue(sources);
      if (Object.keys(store.state.seen).length >= 101) {
        continuing(false);
      }
    };
    const first = await source.poll();
    assert.equal(first.complete, false);
    assert.equal(first.initialComplete, false);
    assert.deepEqual(wire!.pages, [0]);
    assert.equal(JSON.parse(store.state.cursors['tgScan:-4321']!).offset, 151);
    assert.equal(
      store.state.queue.flatMap((batch) => batch.sources).some((x) => x.deleted),
      false,
    );
    continuing(true);
    store.enqueue = enqueue;
    const second = await source.poll();
    assert.equal(second.initialComplete, true);
    assert.deepEqual(wire!.pages, [0, 151, 51]);
    assert.equal(store.state.cursors['tgHistory:-4321'], '1');
    assert.equal(
      store.state.queue
        .flatMap((batch) => batch.sources)
        .some((x) => x.id === 'tg:-4321:999' && x.deleted),
      true,
    );
  }));

test('common resync pins one watermark and resumes remaining chats before another difference RPC', () => {
  const notices: string[] = [];
  return fixture(
    async (source, [wire], store, _root, continuing) => {
      const second = new Api.Chat({ ...group, id: bigInt(4322) });
      source.config.chats.push({ id: '-4322', title: 'Second fixture' });
      const baseline = new Api.updates.State({
        pts: 100,
        qts: 0,
        date: 1791800000,
        seq: 1,
        unreadCount: 0,
      });
      let getStates = 0,
        differences = 0,
        allowDifference = false;
      const pages: { chat: string; offset: number }[] = [];
      const messages = (chat: number, count: number) =>
        Array.from(
          { length: count },
          (_, i) =>
            new Api.Message({
              id: count - i,
              date: 1791800000,
              message: 'Fixture',
              peerId: new Api.PeerChat({ chatId: bigInt(chat) }),
            }),
        );
      const firstHistory = messages(4321, 10),
        secondHistory = messages(4322, 200),
        original = wire!.invoke.bind(wire);
      wire!.invoke = async (request, _dc, options) => {
        if (request instanceof Api.updates.GetState) {
          getStates++;
          return getStates === 1 ? state() : baseline;
        }
        if (request instanceof Api.messages.GetDialogs) {
          const response = await original(request, _dc, options);
          assert.ok(response instanceof Api.messages.Dialogs);
          assert.ok(response.dialogs[0] instanceof Api.Dialog);
          response.chats.push(second);
          response.dialogs.push(
            new Api.Dialog({
              ...response.dialogs[0],
              peer: new Api.PeerChat({ chatId: second.id }),
            }),
          );
          return response;
        }
        if (request instanceof Api.updates.GetDifference) {
          differences++;
          if (differences === 1) {
            return new Api.updates.DifferenceTooLong({ pts: 100 });
          }
          assert.ok(
            allowDifference,
            'a resumed generation must not depend on another difference RPC',
          );
          assert.equal(request.pts, 100);
          return new Api.updates.Difference({
            newMessages: [
              new Api.Message({
                id: 999,
                date: 1791800000,
                message: 'Arrival after watermark',
                peerId: new Api.PeerChat({ chatId: group.id }),
              }),
            ],
            newEncryptedMessages: [],
            otherUpdates: [],
            chats: [],
            users: [],
            state: new Api.updates.State({ ...baseline, pts: 101 }),
          });
        }
        if (request instanceof Api.messages.GetHistory) {
          const chat = (request.peer as Api.InputPeerChat).chatId.toString();
          pages.push({ chat, offset: request.offsetId });
          const history = chat === '4321' ? firstHistory : secondHistory;
          return new Api.messages.Messages({
            topics: [],
            messages: history
              .filter((m) => !request.offsetId || m.id < request.offsetId)
              .slice(0, request.limit),
            chats: [],
            users: [],
          });
        }
        return original(request, _dc, options);
      };
      store.state.cursors.tgState = JSON.stringify(state());
      store.state.cursors['tgHistory:-4321'] = '1';
      store.state.cursors['tgHistory:-4322'] = '1';
      const enqueue = store.enqueue.bind(store);
      store.enqueue = async (sources) => {
        await enqueue(sources);
        if (sources.some((s) => s.id === 'tg:-4322:101')) {
          continuing(false);
        }
      };
      assert.equal((await source.poll()).complete, false);
      const pending = JSON.parse(store.state.cursors.tgResync!);
      assert.deepEqual(pending.done, ['-4321']);
      assert.equal(pending.fresh.pts, 100);
      assert.equal(pending.noticeSent, true);
      assert.equal(notices.length, 1);
      continuing(true);
      store.enqueue = enqueue;
      assert.equal((await source.poll()).complete, true);
      assert.equal(differences, 1);
      assert.equal(getStates, 2);
      assert.equal(notices.length, 1);
      assert.match(notices[0]!, /^tg-resync:/);
      assert.equal(pages.filter((p) => p.chat === '4321').length, 1);
      assert.deepEqual(
        pages.filter((p) => p.chat === '4322').map((p) => p.offset),
        [0, 101, 1],
      );
      assert.equal(store.state.cursors.tgResync, undefined);
      assert.equal(JSON.parse(store.state.cursors.tgState!).pts, 100);
      allowDifference = true;
      await source.poll();
      assert.equal(JSON.parse(store.state.cursors.tgState!).pts, 101);
      assert.ok(
        store.state.queue.flatMap((batch) => batch.sources).some((s) => s.id === 'tg:-4321:999'),
      );
    },
    1,
    async (_text, id) => {
      notices.push(id!);
    },
  );
});

test('channel resync retains target pts and skips unrelated RPCs while resuming pages', () => {
  const notices: string[] = [];
  return fixture(
    async (source, [wire], store, _root, continuing) => {
      const channel = new Api.Channel({
        id: bigInt(1234),
        accessHash: bigInt(42),
        title: 'Fixture channel',
        photo: new Api.ChatPhotoEmpty(),
        date: 1791800000,
        megagroup: true,
      });
      source.config.chats.splice(0, 1, { id: '-1001234', title: 'Fixture channel' });
      const history = Array.from(
        { length: 200 },
        (_, i) =>
          new Api.Message({
            id: 200 - i,
            date: 1791800000,
            message: 'Fixture',
            peerId: new Api.PeerChannel({ channelId: channel.id }),
          }),
      );
      const pages: number[] = [];
      let commonCalls = 0,
        channelCalls = 0,
        allowDifference = false;
      const original = wire!.invoke.bind(wire);
      wire!.invoke = async (request, _dc, options) => {
        if (request instanceof Api.messages.GetDialogs) {
          const response = await original(request, _dc, options);
          assert.ok(response instanceof Api.messages.Dialogs);
          assert.ok(response.dialogs[0] instanceof Api.Dialog);
          response.chats = [channel];
          response.dialogs = [
            new Api.Dialog({
              ...response.dialogs[0],
              peer: new Api.PeerChannel({ channelId: channel.id }),
            }),
          ];
          return response;
        }
        if (request instanceof Api.updates.GetDifference) {
          commonCalls++;
          assert.ok(
            commonCalls === 1 || allowDifference,
            'ordinary common RPC must not gate channel scan continuation',
          );
          return new Api.updates.DifferenceEmpty({ date: 1791800000, seq: 1 });
        }
        if (request instanceof Api.updates.GetChannelDifference) {
          if (++channelCalls === 1) {
            return new Api.updates.ChannelDifferenceTooLong({
              final: true,
              dialog: new Api.Dialog({
                peer: new Api.PeerChannel({ channelId: channel.id }),
                pts: 50,
                topMessage: 200,
                readInboxMaxId: 0,
                readOutboxMaxId: 0,
                unreadCount: 0,
                unreadMentionsCount: 0,
                unreadReactionsCount: 0,
                unreadPollVotesCount: 0,
                notifySettings: new Api.PeerNotifySettings({}),
              }),
              messages: [],
              chats: [],
              users: [],
            });
          }
          assert.ok(allowDifference, 'resuming pages must not fetch a moving channel baseline');
          assert.equal(request.pts, 50);
          return new Api.updates.ChannelDifference({
            final: true,
            pts: 51,
            newMessages: [
              new Api.Message({
                id: 999,
                date: 1791800000,
                message: 'Newer arrival',
                peerId: new Api.PeerChannel({ channelId: channel.id }),
              }),
            ],
            otherUpdates: [],
            chats: [],
            users: [],
          });
        }
        if (request instanceof Api.messages.GetHistory) {
          pages.push(request.offsetId);
          return new Api.messages.Messages({
            topics: [],
            messages: history
              .filter((m) => !request.offsetId || m.id < request.offsetId)
              .slice(0, request.limit),
            chats: [],
            users: [],
          });
        }
        return original(request, _dc, options);
      };
      store.state.cursors.tgState = JSON.stringify(state());
      store.state.cursors['tgHistory:-1001234'] = '1';
      store.state.cursors['tgChannel:-1001234'] = '1';
      const enqueue = store.enqueue.bind(store);
      store.enqueue = async (sources) => {
        await enqueue(sources);
        if (sources.some((s) => s.id === 'tg:-1001234:101')) {
          continuing(false);
        }
      };
      assert.equal((await source.poll()).complete, false);
      assert.equal(JSON.parse(store.state.cursors['tgResyncChannel:-1001234']!).pts, 50);
      assert.equal(notices.length, 1);
      continuing(true);
      store.enqueue = enqueue;
      assert.equal((await source.poll()).complete, false);
      assert.equal(channelCalls, 1);
      assert.equal(commonCalls, 1);
      assert.equal(notices.length, 1);
      assert.equal(notices[0], 'tg-channel-resync:-1001234:50');
      assert.deepEqual(pages, [0, 101, 1]);
      assert.equal(store.state.cursors['tgResyncChannel:-1001234'], undefined);
      assert.equal(store.state.cursors['tgChannel:-1001234'], '50');
      allowDifference = true;
      assert.equal((await source.poll()).complete, true);
      assert.equal(store.state.cursors['tgChannel:-1001234'], '51');
      assert.ok(
        store.state.queue.flatMap((batch) => batch.sources).some((s) => s.id === 'tg:-1001234:999'),
      );
    },
    1,
    async (_text, id) => {
      notices.push(id!);
    },
  );
});

test('uncertain MTProto send retries the original random_id after cancellation', () =>
  fixture(async (source, [wire]) => {
    await source.connect();
    wire!.ambiguousSend = true;
    const ctx = createOperation('approval', 20),
      keeper = setTimeout(() => {}, 1000);
    await assert.rejects(
      source.question('-4321', 'Fixture question', '123', ctx),
      (e) => e instanceof OperationError && e.kind === 'deadline',
    );
    assert.equal(await source.question('-4321', 'Fixture question', '123'), '37');
    assert.deepEqual(wire!.sendIds, ['123', '123']);
    ctx.dispose();
    clearTimeout(keeper);
  }));

test('IMAP whole-operation cancellation closes a continuously active body without advancing UID', async (t) => {
  const oldAddress = process.env.YANDEX_ADDRESS,
    oldPassword = process.env.YANDEX_APP_PASSWORD;
  process.env.YANDEX_ADDRESS = 'fixture@example.test';
  process.env.YANDEX_APP_PASSWORD = 'fixture-only';
  let body: Readable | undefined,
    timer: NodeJS.Timeout | undefined,
    closed = 0;
  t.mock.method(ImapFlow.prototype, 'connect', async () => {});
  t.mock.method(ImapFlow.prototype, 'close', () => {
    closed++;
    body?.destroy(Error('fixture close'));
    if (timer) {
      clearInterval(timer);
    }
  });
  t.mock.method(ImapFlow.prototype, 'getMailboxLock', async function (this: ImapFlow) {
    this.mailbox = {
      uidValidity: 7n,
      path: 'INBOX',
      delimiter: '/',
      flags: new Set(),
      uidNext: 2,
      exists: 1,
    };
    return { release() {} };
  });
  t.mock.method(ImapFlow.prototype, 'search', async () => [1]);
  t.mock.method(ImapFlow.prototype, 'fetchAll', async () => [
    {
      uid: 1,
      internalDate: new Date('2026-10-16'),
      bodyStructure: { type: 'text/plain', part: '1' },
      envelope: { messageId: 'fixture' },
    },
  ]);
  t.mock.method(ImapFlow.prototype, 'download', async () => {
    body = new Readable({ read() {} });
    timer = setInterval(() => body!.push('active'), 2);
    return { content: body };
  });
  const store = memoryStore(),
    ctx = createOperation('source', 30);
  try {
    await assert.rejects(
      new MailSource(normalizeSetupConfig({ folders: ['INBOX'] }), store).poll(ctx),
      (e) => e instanceof OperationError && e.kind === 'deadline',
    );
    assert.ok(closed);
    assert.deepEqual(store.state.cursors, {});
    assert.equal(store.state.queue.length, 0);
  } finally {
    ctx.dispose();
    if (timer) {
      clearInterval(timer);
    }
    oldAddress === undefined
      ? delete process.env.YANDEX_ADDRESS
      : (process.env.YANDEX_ADDRESS = oldAddress);
    oldPassword === undefined
      ? delete process.env.YANDEX_APP_PASSWORD
      : (process.env.YANDEX_APP_PASSWORD = oldPassword);
  }
});

test('aborted Google pagination retains previous snapshot and token', async () => {
  const store = memoryStore();
  store.state.cursors['calendarSnapshot:google:fixture'] = '["previous"]';
  store.state.calendarTokens['google:fixture'] = 'old-token';
  let requests = 0;
  const api = {
    async request(_path: string, _method: string, _body: unknown, ctx: OperationContext) {
      if (++requests === 1) {
        return { items: [{ id: 'new', summary: 'Fixture' }], nextPageToken: 'next' };
      }
      return new Promise((_, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
      });
    },
  } as unknown as Google;
  const collection = new GoogleCollection(api, 'fixture'),
    calendar = new StudyCalendar(collection, emptyCollection('other')),
    ctx = createOperation('source', 20),
    keeper = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      calendar.syncSchedule(store, ctx),
      (e) => e instanceof OperationError && e.kind === 'deadline',
    );
    assert.equal(store.state.calendarTokens['google:fixture'], 'old-token');
    assert.equal(store.state.cursors['calendarSnapshot:google:fixture'], '["previous"]');
    assert.equal(store.state.queue.length, 0);
  } finally {
    ctx.dispose();
    clearTimeout(keeper);
  }
});

test('calendar decoded body limit rejects streamed responses without Content-Length', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024));
      controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      controller.close();
    },
  });
  await assert.rejects(
    limitedResponse(new Response(body)).text(),
    (e) => e instanceof OperationError && e.kind === 'payload-limit',
  );
});

test('CalDAV fetch combines caller cancellation with its request deadline', async (t) => {
  const ctx = createOperation('tool', 20),
    keeper = setTimeout(() => {}, 1000);
  let combined = false;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, options?: RequestInit) => {
    combined = options?.signal !== ctx.signal;
    return new Promise((_, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
        once: true,
      });
    });
  });
  try {
    await assert.rejects(iCloudFetch('https://caldav.icloud.com/fixture/', { signal: ctx.signal }));
    assert.ok(combined);
  } finally {
    ctx.dispose();
    clearTimeout(keeper);
  }
});

test('lazy calendar retries failed discovery instead of caching rejection', async () => {
  let calls = 0;
  const calendar = await createCalendar(normalizeSetupConfig({}), {
    icloud: async (id) => {
      if (++calls === 1) {
        throw Error('fixture offline');
      }
      return emptyCollection(id);
    },
    google: async () => {
      throw Error('must not open');
    },
  });
  assert.equal(calls, 0);
  await assert.rejects(calendar.listTasks(), /fixture offline/);
  assert.deepEqual(await calendar.listTasks(), []);
  assert.equal(calls, 2);
});

test('Telegram setup network budget excludes time spent answering human prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'telegram-auth-budget-')),
    path = join(root, 'session'),
    oldId = process.env.TELEGRAM_API_ID,
    oldHash = process.env.TELEGRAM_API_HASH;
  process.env.TELEGRAM_API_ID = '123';
  process.env.TELEGRAM_API_HASH = 'fixture';
  await writeFile(path, 'previous');
  const client: TelegramSetupClient = {
    async start(parameters) {
      await (parameters.phoneNumber as () => Promise<string>)();
      await pause(2);
    },
    async getMe() {
      return { id: 42n };
    },
    async getDialogs() {
      return [];
    },
    session: { save: () => 'replacement' },
    async disconnect() {},
  };
  const ui = setupUI({
    note() {},
    async input() {
      await pause(120);
      return 'fixture';
    },
    async task<T>(_label: string, run: (signal?: AbortSignal) => Promise<T>) {
      return run();
    },
  });
  try {
    await setupTelegram(ui, 42, {
      createClient: () => client,
      sessionPath: path,
      networkBudgetMs: 80,
    });
    assert.equal(await readFile(path, 'utf8'), 'replacement');
  } finally {
    oldId === undefined
      ? delete process.env.TELEGRAM_API_ID
      : (process.env.TELEGRAM_API_ID = oldId);
    oldHash === undefined
      ? delete process.env.TELEGRAM_API_HASH
      : (process.env.TELEGRAM_API_HASH = oldHash);
    await rm(root, { recursive: true, force: true });
  }
});

for (const phase of ['start', 'lateStartInput', 'getMe', 'getDialogs'] as const) {
  test(`Telegram setup joins delayed ${phase} settlement after destroy before returning to rollback`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'telegram-setup-join-')),
      path = join(root, 'session');
    const oldId = process.env.TELEGRAM_API_ID,
      oldHash = process.env.TELEGRAM_API_HASH;
    process.env.TELEGRAM_API_ID = '123';
    process.env.TELEGRAM_API_HASH = 'fixture';
    await writeFile(path, 'previous-session');
    const sdk = deferred<void>(),
      destroyed = deferred<void>();
    let sessionSaves = 0,
      returnedToCaller = false,
      inputCalls = 0;
    const client: TelegramSetupClient = {
      async start(parameters) {
        if (phase === 'start') {
          await sdk.promise;
        }
        if (phase === 'lateStartInput') {
          await sdk.promise;
          await (parameters.phoneNumber as () => Promise<string>)();
        }
      },
      async getMe() {
        if (phase === 'getMe') {
          await sdk.promise;
        }
        return { id: 42n };
      },
      async getDialogs() {
        if (phase === 'getDialogs') {
          await sdk.promise;
        }
        return [];
      },
      session: {
        save() {
          sessionSaves++;
          return 'must-not-persist';
        },
      },
      async destroy() {
        destroyed.resolve();
      },
      async disconnect() {
        destroyed.resolve();
      },
    };
    const ui = setupUI({
      note() {},
      async input() {
        inputCalls++;
        throw Error('No human prompt expected');
      },
      async task<T>(_label: string, run: (signal?: AbortSignal) => Promise<T>) {
        if (phase !== 'getDialogs') {
          return run();
        }
        const controller = new AbortController(),
          running = run(controller.signal);
        queueMicrotask(() => controller.abort());
        return running;
      },
    });

    const outcome = setupTelegram(ui, 42, {
      createClient: () => client,
      sessionPath: path,
      networkBudgetMs: phase === 'getDialogs' ? 1000 : 15,
    })
      .then(
        () => ({ ok: true, error: undefined }),
        (error) => ({ ok: false, error }),
      )
      .finally(() => {
        returnedToCaller = true;
      });
    try {
      await destroyed.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      assert.equal(
        returnedToCaller,
        false,
        'resource disposal alone must not release setup rollback',
      );
      assert.equal(sessionSaves, 0);
      assert.equal(await readFile(path, 'utf8'), 'previous-session');
      if (phase === 'lateStartInput') {
        sdk.resolve(undefined);
      } else {
        sdk.reject(Error('Delayed fixture SDK rejection'));
      }
      const result = await outcome;
      assert.equal(result.ok, false);
      assert.equal(inputCalls, 0, 'a cancelled SDK must not open another human prompt');
      assert.equal(sessionSaves, 0);
      assert.equal(await readFile(path, 'utf8'), 'previous-session');
    } finally {
      sdk.reject(Error('Fixture cleanup'));
      await outcome;
      oldId === undefined
        ? delete process.env.TELEGRAM_API_ID
        : (process.env.TELEGRAM_API_ID = oldId);
      oldHash === undefined
        ? delete process.env.TELEGRAM_API_HASH
        : (process.env.TELEGRAM_API_HASH = oldHash);
      await rm(root, { recursive: true, force: true });
    }
  });
}
