import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerLifecycle, WorkerControl, type WorkerCommand } from '../src/worker/lifecycle.js';
import { Store, processLock } from '../src/store.js';
import { TelegramBot, BotApiRejection } from '../src/bot.js';
import { Scheduler } from '../src/scheduler.js';

const command = (type: WorkerCommand['type'], sequence: number): WorkerCommand => ({
  protocolVersion: 1,
  attemptId: 'attempt',
  workerId: 'worker',
  sequence,
  type,
});
async function fixture(run: (store: Store) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'update-worker-'));
  const store = new Store(dir);
  await store.load();
  try {
    await run(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('drain closes root admission but accepted turns can finish nested tools and saves', async () => {
  const life = new WorkerLifecycle();
  life.activate();
  const entered = deferred(),
    release = deferred();
  let nested = false,
    forbidden = false;
  const turn = life.run(async () => {
    entered.resolve();
    await release.promise;
    await life.run(async () => {
      nested = true;
    });
  });
  await entered.promise;
  life.drain();
  await life.run(async () => {
    forbidden = true;
  });
  assert.equal(forbidden, false);
  assert.equal(life.inFlight, 1);
  release.resolve();
  await turn;
  await life.idle();
  life.quiescent();
  assert.equal(nested, true);
  assert.equal(life.inFlight, 0);
  life.finish();
  assert.throws(() => life.activate());
});
test(
  'resume cancels a late quiescent acknowledgement without aborting accepted operation',
  { timeout: 5000 },
  async () => {
    const life = new WorkerLifecycle(),
      release = deferred();
    const replies: Record<string, unknown>[] = [];
    let checkpoints = 0;
    const ctl = new WorkerControl(
      life,
      'worker',
      {
        prepare: async () => {},
        activate: async () => {},
        checkpoint: async () => {
          checkpoints++;
        },
        finish: async () => {},
        notice: async () => {},
        health: () => ({}),
      },
      (m) => replies.push(m),
    );
    try {
      await ctl.receive(command('prepare', 1));
      await ctl.receive(command('activate', 2));
      const turn = life.run(() => release.promise);
      const draining = ctl.receive(command('drain', 3));
      await ctl.receive(command('resume', 4));
      await draining;
      release.resolve();
      await turn;
      assert.equal(life.mode, 'active');
      assert.equal(checkpoints, 0);
      assert.equal(
        replies.some((m) => m.type === 'quiescent'),
        false,
      );
      await ctl.receive(command('finish', 3));
      assert.equal(life.mode, 'active');
      await ctl.receive(command('drain', 5));
      assert.equal(replies.at(-1)?.type, 'quiescent');
      await ctl.receive(command('finish', 6));
      assert.equal(life.mode, 'finishing');
    } finally {
      ctl.close();
    }
  },
);
test('a notice racing drain does not advance control sequence; closed admission keeps notice pending', async () => {
  const life = new WorkerLifecycle(),
    release = deferred();
  const replies: Record<string, unknown>[] = [];
  let notices = 0;
  const ctl = new WorkerControl(
    life,
    'worker',
    {
      prepare: async () => {},
      activate: async () => {},
      checkpoint: async () => {},
      finish: async () => {},
      notice: async () => {
        notices++;
      },
      health: () => ({}),
    },
    (m) => replies.push(m),
  );
  try {
    await ctl.receive(command('prepare', 1));
    await ctl.receive(command('activate', 2));
    const turn = life.run(() => release.promise);
    const draining = ctl.receive(command('drain', 3));
    await ctl.receive({ ...command('notice', 4), text: 'updated', id: 'update' });
    assert.equal(notices, 0);
    release.resolve();
    await turn;
    await draining;
    assert.equal(replies.at(-1)?.type, 'quiescent');
    assert.equal(replies.at(-1)?.sequence, 3);
    await ctl.receive(command('resume', 5));
    await ctl.receive({ ...command('notice', 6), text: 'updated', id: 'update' });
    assert.equal(replies.at(-1)?.type, 'notice-sent');
    assert.equal(notices, 1);
  } finally {
    ctl.close();
  }
});
test('failed checkpoint cannot acknowledge quiescent', async () => {
  const life = new WorkerLifecycle(),
    replies: Record<string, unknown>[] = [];
  const ctl = new WorkerControl(
    life,
    'worker',
    {
      prepare: async () => {},
      activate: async () => {},
      checkpoint: async () => {
        throw Error('disk');
      },
      finish: async () => {},
      notice: async () => {},
      health: () => ({}),
    },
    (m) => replies.push(m),
  );
  try {
    await ctl.receive(command('prepare', 1));
    await ctl.receive(command('activate', 2));
    await assert.rejects(() => ctl.receive(command('drain', 3)));
    assert.equal(replies.at(-1)?.type, 'fatal');
    assert.equal(life.mode, 'draining');
    assert.equal(
      replies.some((m) => m.type === 'quiescent'),
      false,
    );
  } finally {
    ctl.close();
  }
});
test('owner update receipt survives recovery without advancing the command coordinator offset', () =>
  fixture(async (store) => {
    await store.enqueueOwner('Сдал ДЗ', 10);
    const recovered = new Store(store.dir);
    await recovered.load();
    await recovered.enqueueOwner('Сдал ДЗ', 10);
    assert.equal(recovered.state.queue.length, 1);
    assert.equal(recovered.state.queue[0]?.id, 'owner:10');
    assert.equal(recovered.state.botOffset, 0);
    recovered.state.queue = [];
    await recovered.save();
    await recovered.enqueueOwner('Сдал ДЗ', 10);
    assert.equal(recovered.state.queue.length, 0);
  }));
test('Store.flush and later saves retain a previous fatal write failure', () =>
  fixture(async (store) => {
    await mkdir(join(store.dir, 'operations.json'));
    await assert.rejects(() => store.save());
    await rm(join(store.dir, 'operations.json'), { recursive: true });
    await assert.rejects(() => store.save());
    await assert.rejects(() => store.flush());
  }));
test('readonly legacy validation creates no state files and rejects future schema', () =>
  fixture(async (store) => {
    const path = join(store.dir, 'operations.json');
    const legacy = { ...store.state } as Record<string, unknown>;
    delete legacy.schemaVersion;
    delete legacy.outbox;
    await writeFile(path, JSON.stringify(legacy));
    const before = await readFile(path, 'utf8');
    const reader = new Store(store.dir);
    await reader.load({ readOnly: true });
    assert.equal(await readFile(path, 'utf8'), before);
    await writeFile(path, JSON.stringify({ ...legacy, schemaVersion: 99 }));
    await assert.rejects(() => reader.load({ readOnly: true }));
    const missing = join(store.dir, 'absent');
    await new Store(missing).load({ readOnly: true });
    await assert.rejects(access(missing), { code: 'ENOENT' });
  }));
test('lock refuses live/PID-reused ownership and unlock never deletes another incarnation', () =>
  fixture(async (store) => {
    await writeFile(
      join(store.dir, 'service.lock'),
      JSON.stringify({ pid: process.pid, nonce: 'foreign' }),
    );
    await assert.rejects(() => processLock(store.dir));
    await rm(join(store.dir, 'service.lock'));
    const unlock = await processLock(store.dir);
    await writeFile(
      join(store.dir, 'service.lock'),
      JSON.stringify({ pid: process.pid, nonce: 'new' }),
    );
    await unlock();
    assert.match(await readFile(join(store.dir, 'service.lock'), 'utf8'), /new/);
  }));
test('per-chunk receipts resume only unconfirmed chunks and disclose uncertain external send', () =>
  fixture(async (store) => {
    const calls: string[] = [];
    let fail = true;
    class Bot extends TelegramBot {
      override async call<T>(_method: string, args: unknown): Promise<T> {
        const text = (args as { text: string }).text;
        calls.push(text);
        if (calls.length === 2 && fail) {
          throw Error('response lost');
        }
        return { message_id: calls.length } as T;
      }
    }
    const text = 'x'.repeat(7200);
    await assert.rejects(() => new Bot(1, store).send(text, undefined, 'answer:1'));
    await store.flush();
    assert.deepEqual(
      store.state.outbox['answer:1']?.chunks.map((x) => x.state),
      ['sent', 'sending', 'pending'],
    );
    const recovered = new Store(store.dir);
    await recovered.load();
    fail = false;
    await new Bot(1, recovered).send(text, undefined, 'answer:1');
    assert.equal(calls.length, 4);
    assert.match(calls[2]!, /^Повтор после сбоя/);
    await new Bot(1, recovered).send(text, undefined, 'answer:1');
    assert.equal(calls.length, 4);
    assert.ok(recovered.state.outbox['answer:1']?.ambiguous);
  }));
test('definitive Telegram rejection remains pending without ambiguous-success claim', () =>
  fixture(async (store) => {
    let fail = true;
    const messages: string[] = [];
    class Bot extends TelegramBot {
      override async call<T>(_m: string, args: unknown): Promise<T> {
        if (fail) {
          throw new BotApiRejection('offline');
        }
        messages.push((args as { text: string }).text);
        return { message_id: 1 } as T;
      }
    }
    await assert.rejects(() => new Bot(1, store).send('hello', undefined, 'notice:1'));
    assert.equal(store.state.outbox['notice:1']?.chunks[0]?.state, 'pending');
    fail = false;
    await new Bot(1, store).send('hello', undefined, 'notice:1');
    assert.deepEqual(messages, ['hello']);
  }));
test('digests catch up across 11:00/21:00 within two hours and mark older missed windows', () =>
  fixture(async (store) => {
    const s = new Scheduler(store, { send: async () => {} });
    await s.digests(Date.parse('2026-10-13T08:01:00Z'));
    await s.digests(Date.parse('2026-10-13T18:01:00Z'));
    assert.deepEqual(
      store.state.queue.map((q) => q.digest),
      ['morning', 'evening'],
    );
    await s.digests(Date.parse('2026-10-13T18:02:00Z'));
    assert.equal(store.state.queue.length, 2);
    store.state.queue = [];
    await s.digests(Date.parse('2026-10-14T09:01:00Z'));
    assert.ok(store.state.missedDigests['digest:2026-10-14:10']);
    assert.equal(store.state.queue.length, 0);
  }));

test('Pi operation result survives recovery without another prompt, including crash before result marker', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { PiAssistant } = await import('../src/pi.js');
  const pi = new PiAssistant();
  pi.manager = SessionManager.inMemory();
  pi.manager.appendCustomEntry('hse-operation-start', { turnId: 'owner:123' });
  pi.manager.appendMessage({ role: 'user', content: 'Дай ответ', timestamp: 1 });
  pi.manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'Готовый ответ' }],
    api: 'openai-responses',
    provider: 'openai',
    model: 'fixture',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 2,
  });
  assert.equal(await pi.completedTurn('owner:123'), 'Готовый ответ');
  assert.equal(await pi.completedTurn('owner:123'), 'Готовый ответ');
  assert.equal(
    pi.manager
      .getEntries()
      .filter((e) => e.type === 'custom' && e.customType === 'hse-operation-result').length,
    1,
  );
  assert.equal(await pi.completedTurn('owner:other'), undefined);
});

test('bot identity namespaces reused update IDs, resets offset only at activation and preserves prior queue/memory', () =>
  fixture(async (store) => {
    const { botIdentity } = await import('../src/bot.js');
    const oldBot = botIdentity('12345:old-secret'),
      sameBot = botIdentity('12345:rotated-secret'),
      newBot = botIdentity('67890:new-secret');
    assert.equal(oldBot, sameBot);
    assert.equal(oldBot, 'telegram:12345');
    assert.ok(!botIdentity('fixture-secret').includes('fixture-secret'));
    await store.enqueueOwner('legacy pending answer', 10);
    store.state.botOffset = 11;
    store.state.sessionPath = '/existing/pi.jsonl';
    store.state.queue[0]!.phase = 'answer';
    store.state.queue[0]!.answer = 'saved answer';
    await store.save();
    const legacyBytes = await readFile(join(store.dir, 'operations.json'), 'utf8');
    const prepared = new Store(store.dir);
    await prepared.load({ readOnly: true });
    assert.equal(prepared.state.botIdentity, undefined);
    assert.equal(prepared.state.botOffset, 11);
    assert.equal(await readFile(join(store.dir, 'operations.json'), 'utf8'), legacyBytes);
    await prepared.activateBot(oldBot);
    assert.equal(prepared.state.botOffset, 11);
    await prepared.enqueueOwner('legacy duplicate', 10);
    assert.equal(prepared.state.queue.length, 1);
    await prepared.activateBot(sameBot);
    assert.equal(prepared.state.botOffset, 11);
    const queueBefore = structuredClone(prepared.state.queue);
    const beforeSwitch = await readFile(join(store.dir, 'operations.json'), 'utf8');
    const candidate = new Store(store.dir);
    await candidate.load({ readOnly: true });
    assert.equal(candidate.state.botOffset, 11);
    assert.equal(await readFile(join(store.dir, 'operations.json'), 'utf8'), beforeSwitch);
    const life = new WorkerLifecycle(),
      replies: Record<string, unknown>[] = [];
    const ctl = new WorkerControl(
      life,
      'worker',
      {
        prepare: async () => {},
        activate: async () => {
          await candidate.activateBot(newBot);
        },
        checkpoint: async () => {},
        finish: async () => {},
        notice: async () => {},
        health: () => ({}),
      },
      (m) => replies.push(m),
    );
    try {
      await ctl.receive(command('prepare', 1));
      assert.equal(replies.at(-1)?.type, 'boot-ready');
      assert.equal(candidate.state.botOffset, 11);
      assert.equal(await readFile(join(store.dir, 'operations.json'), 'utf8'), beforeSwitch);
      await ctl.receive(command('activate', 2));
    } finally {
      ctl.close();
    }
    assert.equal(candidate.state.botOffset, 0);
    assert.deepEqual(candidate.state.queue, queueBefore);
    assert.equal(candidate.state.sessionPath, '/existing/pi.jsonl');
    await candidate.enqueueOwner('new bot message, same update ID', 10);
    assert.equal(candidate.state.queue.length, 2);
    assert.equal(candidate.state.botOffset, 0);
    candidate.state.botOffset = 11;
    await candidate.save();
    assert.equal(candidate.state.queue[1]?.id, `owner:${newBot}:10`);
    await candidate.enqueueOwner('duplicate', 10);
    assert.equal(candidate.state.queue.length, 2);
    const recovered = new Store(store.dir);
    await recovered.load({ readOnly: true });
    assert.equal(recovered.state.botIdentity, newBot);
    assert.equal(recovered.state.botOffset, 11);
  }));

test('failed source turn cannot borrow a later successful priority-owner response during JSONL recovery', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const { PiAssistant } = await import('../src/pi.js');
  const pi = new PiAssistant();
  pi.manager = SessionManager.inMemory();
  const assistant = (text: string, stopReason: 'stop' | 'error') => ({
    role: 'assistant' as const,
    content: text ? [{ type: 'text' as const, text }] : [],
    api: 'openai-responses' as const,
    provider: 'openai',
    model: 'fixture',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 2,
    ...(stopReason === 'error' ? { errorMessage: 'Provider unavailable' } : {}),
  });
  pi.manager.appendCustomEntry('hse-operation-start', { turnId: 'source-d' });
  pi.manager.appendMessage({ role: 'user', content: 'ДЗ D до 16 октября', timestamp: 1 });
  pi.manager.appendMessage(assistant('', 'error'));
  pi.manager.appendCustomEntry('hse-operation-start', { turnId: 'owner-priority' });
  pi.manager.appendMessage({ role: 'user', content: 'Ответь владельцу первым', timestamp: 3 });
  pi.manager.appendMessage(assistant('Приоритетный личный ответ.', 'stop'));
  pi.manager.appendCustomEntry('hse-operation-result', {
    turnId: 'owner-priority',
    answer: 'Приоритетный личный ответ.',
  });
  assert.equal(await pi.completedTurn('source-d'), undefined);
  assert.equal(await pi.completedTurn('owner-priority'), 'Приоритетный личный ответ.');
  assert.equal(
    pi.manager
      .getEntries()
      .filter(
        (e) =>
          e.type === 'custom' &&
          e.customType === 'hse-operation-result' &&
          (e.data as { turnId?: string }).turnId === 'source-d',
      ).length,
    0,
  );
});
