import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { TelegramBot, type BotUpdate } from '../src/bot.js';
import { TelegramUpdates } from '../src/updates/telegram.js';
import { latestRelease, type AvailableRelease } from '../src/updates/releases.js';
import type { UpdateRuntime, UpdateSnapshot } from '../src/updates/runtime.js';
const integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
const release = (version = '0.2.3'): AvailableRelease => ({ version, integrity });
const owner = (id = 1, data?: string, from = 1, type = 'private'): BotUpdate =>
  data
    ? {
        update_id: id,
        callback_query: {
          id: String(id),
          from: { id: from },
          message: { chat: { id: from, type } },
          data,
        },
      }
    : {
        update_id: id,
        message: { message_id: id, from: { id: from }, chat: { id: from, type }, text: '/updates' },
      };
class Bot extends TelegramBot {
  messages: {
    text: string;
    reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
  }[] = [];
  down = false;
  override get identity() {
    return 'telegram:1';
  }
  override async call<T>(method: string, args: unknown): Promise<T> {
    assert.equal(method, 'sendMessage');
    if (this.down) {
      throw Error('connection lost');
    }
    assert.ok(args && typeof args === 'object' && 'text' in args && typeof args.text === 'string');
    this.messages.push(args as (typeof this.messages)[number]);
    return { message_id: this.messages.length } as T;
  }
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'hse-tg-updates-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let generation = 1;
  let store = new Store(dir);
  await store.load();
  let bot = new Bot(1, store);
  let time = Date.parse('2026-10-14T20:59:00Z'),
    latest = release(),
    calls = 0,
    installs = 0,
    grants = 0,
    restores = 0;
  const snapshot: UpdateSnapshot = {
    runningVersion: '0.2.2',
    installedVersion: '0.2.2',
    updatesEnabled: true,
    stable: true,
    quarantined: [],
  };
  const runtime: UpdateRuntime = {
    snapshot: async () => snapshot,
    grant: async () => {
      grants++;
      snapshot.updatesEnabled = true;
    },
    restore: async () => {
      restores++;
    },
    install: async (r) => {
      installs++;
      snapshot.installedVersion = r.version;
    },
  };
  const abort = new AbortController();
  const make = (id = 'worker1') =>
    new TelegramUpdates(
      store,
      bot,
      runtime,
      id,
      abort.signal,
      async () => {
        calls++;
        return latest;
      },
      () => time,
    );
  return {
    dir,
    store,
    bot,
    runtime,
    snapshot,
    abort,
    make,
    get counts() {
      return { calls, installs, grants, restores };
    },
    setTime: (n: number) => {
      time += n;
    },
    setLatest: (r: AvailableRelease) => {
      latest = r;
    },
    button: () => bot.messages.at(-1)!.reply_markup!.inline_keyboard[0]![0]!.callback_data,
    restart: async () => {
      store = new Store(dir);
      await store.load();
      bot = new Bot(1, store);
      return { store, bot, updates: make('worker' + ++generation) };
    },
  };
}

test('hourly discovery offers a native inline button once per 24h across versions and restarts, never installs automatically', async (t) => {
  const f = await fixture(t),
    u = f.make();
  await u.tick();
  assert.equal(f.bot.messages.length, 1);
  assert.equal(f.bot.messages[0]!.reply_markup!.inline_keyboard[0]![0]!.text, 'Обновить');
  assert.ok(Buffer.byteLength(f.button()) <= 64);
  assert.equal(f.counts.installs, 0);
  f.setTime(3600_000);
  f.setLatest(release('0.2.4'));
  await u.tick();
  assert.equal(f.counts.calls, 2);
  assert.equal(f.bot.messages.length, 1);
  const resumed = await f.restart();
  await resumed.updates.tick();
  assert.equal(resumed.bot.messages.length, 0);
  f.setTime(23 * 3600_000);
  await resumed.updates.tick();
  assert.equal(resumed.bot.messages.length, 1);
  assert.match(resumed.bot.messages[0]!.text, /0.2.4/);
  assert.equal(f.counts.installs, 0);
});

test('only the owner private chat can approve a current button; duplicate concurrent callbacks install once', async (t) => {
  const f = await fixture(t),
    u = f.make();
  await u.tick();
  const button = f.button();
  await u.callback(owner(2, button, 2));
  await u.callback(owner(3, button, 1, 'group'));
  await u.callback(owner(4, 'hse_update:forged'));
  assert.equal(f.counts.grants, 0);
  await Promise.all([u.callback(owner(5, button)), u.callback(owner(6, button))]);
  assert.equal(f.counts.grants, 1);
  const resumed = await f.restart();
  await resumed.updates.tick();
  assert.equal(f.counts.installs, 1);
  assert.equal(resumed.store.state.npmUpdates?.request?.phase, 'awaiting-apply');
  await resumed.updates.tick();
  assert.equal(f.counts.installs, 1);
  f.snapshot.runningVersion = '0.2.3';
  f.snapshot.stable = false;
  await resumed.updates.tick();
  assert.notEqual(resumed.store.state.npmUpdates?.request?.phase, 'completed');
  f.snapshot.stable = true;
  await resumed.updates.tick();
  assert.equal(resumed.store.state.npmUpdates?.request?.phase, 'completed');
  assert.equal(f.counts.restores, 1);
  assert.equal(resumed.bot.messages.length, 0, 'success notice belongs to the existing supervisor');
});

test('changed release identity refreshes the offer and requires a new approval; /updates bypasses daily cooldown', async (t) => {
  const f = await fixture(t),
    u = f.make();
  await u.tick();
  const old = f.button();
  f.setLatest(release('0.2.4'));
  await u.callback(owner(2, old));
  assert.equal(f.counts.installs, 0);
  assert.notEqual(f.button(), old);
  await u.checkManually(owner(3));
  assert.match(f.bot.messages.at(-1)!.text, /0.2.4/);
  await u.callback(owner(4, old));
  assert.equal(f.counts.grants, 0);
});

test('lost Bot API response keeps one durable delivery identity across midnight and restart', async (t) => {
  const f = await fixture(t),
    u = f.make();
  f.bot.down = true;
  await u.tick();
  const pending = f.store.state.npmUpdates!.pendingNotice!;
  assert.ok(pending);
  const keys = Object.keys(f.store.state.outbox);
  assert.equal(keys.length, 1);
  f.setTime(120_000);
  const resumed = await f.restart();
  await resumed.updates.tick();
  assert.equal(resumed.bot.messages.length, 1);
  assert.equal(resumed.store.state.npmUpdates?.pendingNotice, undefined);
  assert.deepEqual(Object.keys(resumed.store.state.outbox), keys);
  assert.equal(resumed.store.state.outbox[pending.id]!.chunks[0]!.state, 'sent');
  await resumed.updates.tick();
  assert.equal(resumed.bot.messages.length, 1);
});

test('authorizing crash recovers; interrupted installation fails visibly and can be explicitly retried', async (t) => {
  const f = await fixture(t),
    u = f.make();
  await u.tick();
  await u.callback(owner(2, f.button()));
  const q = f.store.state.npmUpdates!.request!;
  q.phase = 'authorizing';
  await f.store.save();
  let resumed = await f.restart();
  await resumed.updates.tick();
  assert.equal(f.counts.installs, 1);
  assert.equal(f.counts.grants, 2);
  f.snapshot.installedVersion = '0.2.2';
  resumed.store.state.npmUpdates!.request!.phase = 'installing';
  await resumed.store.save();
  resumed = await f.restart();
  await resumed.updates.tick();
  assert.equal(resumed.store.state.npmUpdates?.request?.phase, 'failed');
  assert.match(resumed.bot.messages[0]!.text, /не завершено/);
  const button = resumed.bot.messages[0]!.reply_markup!.inline_keyboard[0]![0]!.callback_data;
  await resumed.updates.callback(owner(3, button));
  await resumed.updates.tick();
  assert.equal(f.counts.installs, 2);
});

test('quarantined release is retried only on explicit approval and waits for supervisor consumption', async (t) => {
  const f = await fixture(t),
    u = f.make();
  await u.tick();
  f.snapshot.quarantined = ['0.2.3'];
  f.snapshot.installedVersion = '0.2.3';
  f.runtime.install = async () => {
    f.snapshot.retryPending = true;
  };
  await u.callback(owner(2, f.button()));
  await u.tick();
  await u.tick();
  assert.equal(f.store.state.npmUpdates?.request?.phase, 'awaiting-apply');
  f.snapshot.retryPending = false;
  await u.tick();
  assert.equal(f.store.state.npmUpdates?.request?.phase, 'failed');
});

test('registry errors are optional, unmanaged runs do not poll, durable state failure propagates', async (t) => {
  const f = await fixture(t);
  const bad = new TelegramUpdates(f.store, f.bot, f.runtime, 'w', f.abort.signal, async () => {
    throw Error('registry offline');
  });
  await bad.tick();
  assert.equal(f.bot.messages.length, 0);
  f.runtime.snapshot = async () => undefined;
  await f.make().tick();
  await f.make().checkManually(owner());
  assert.match(f.bot.messages[0]!.text, /npm-пакета/);
  f.runtime.snapshot = async () => f.snapshot;
  f.store.state.npmUpdates = {};
  f.store.save = async () => {
    throw Error('disk full');
  };
  await assert.rejects(f.make().tick(), /disk full/);
});

test('latest metadata rejects incomplete scanning, prereleases, foreign archives and malformed integrity', async () => {
  const valid = () => ({
    'dist-tags': { latest: '0.2.3' },
    versions: {
      '0.2.3': {
        name: '@ivan-boss/hse-harness',
        version: '0.2.3',
        dist: {
          integrity,
          tarball: 'https://registry.npmjs.org/@ivan-boss/hse-harness/-/hse-harness-0.2.3.tgz',
        },
      },
    },
  });
  assert.deepEqual(
    await latestRelease((async () => Response.json(valid())) as typeof fetch),
    release(),
  );
  for (const mutate of [
    (x: ReturnType<typeof valid>) => {
      delete (x.versions as Partial<typeof x.versions>)['0.2.3'];
    },
    (x: ReturnType<typeof valid>) => (x['dist-tags'].latest = '0.2.3-beta.1'),
    (x: ReturnType<typeof valid>) =>
      (x.versions['0.2.3'].dist.tarball = 'https://evil.test/package.tgz'),
    (x: ReturnType<typeof valid>) => (x.versions['0.2.3'].dist.integrity = 'bad'),
    (x: ReturnType<typeof valid>) => (x.versions['0.2.3'].name = 'other'),
  ]) {
    const data = valid();
    mutate(data);
    await assert.rejects(latestRelease((async () => Response.json(data)) as typeof fetch));
  }
});
