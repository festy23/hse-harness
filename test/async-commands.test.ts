import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandCoordinator } from '../src/worker/commands.js';
import { WorkerLifecycle, WorkerControl } from '../src/worker/lifecycle.js';
import type { Store } from '../src/store.js';
import type { BotUpdate } from '../src/bot.js';
import {
  createOperation,
  withOperation,
  OperationError,
  activeOperations,
} from '../src/operations.js';
const turn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
function fixture(
  handle: (u: BotUpdate) => Promise<void>,
  slowCapacity = 32,
  answerCallback?: (id: string) => Promise<void>,
) {
  const lifecycle = new WorkerLifecycle();
  lifecycle.activate();
  const offsets: number[] = [];
  const store = {
    state: { botOffset: 0 },
    save: async () => {
      offsets.push(store.state.botOffset);
    },
  } as unknown as Store;
  const coordinator = new CommandCoordinator(lifecycle, store, handle, {
    isFast: (u) => u.message?.text === '/help',
    onError: async (e) => {
      throw e;
    },
    slowCapacity,
    answerCallback,
  });
  const update = (id: number, fast = false): BotUpdate => ({
    update_id: id,
    message: { message_id: id, chat: { id: 1, type: 'private' }, text: fast ? '/help' : '/tasks' },
  });
  return { lifecycle, store, offsets, coordinator, update };
}
test('slow lower command does not block fast response and sparse IDs advance only after prefix completes', async () => {
  const slow = gate(),
    done: number[] = [];
  const f = fixture(async (u) => {
    if (u.update_id === 10) {
      await slow.promise;
    }
    done.push(u.update_id);
  });
  f.coordinator.observe([f.update(10), f.update(20, true)]);
  await turn();
  await f.coordinator.advance();
  assert.deepEqual(done, [20]);
  assert.equal(f.store.state.botOffset, 0);
  f.coordinator.observe([f.update(10), f.update(20, true)]);
  await turn();
  assert.deepEqual(done, [20]);
  slow.release();
  await f.coordinator.idle();
  await f.coordinator.advance();
  assert.deepEqual(done, [20, 10]);
  assert.equal(f.store.state.botOffset, 21);
});
test('unadmitted overflow remains an acknowledgement barrier while fast lane progresses', async () => {
  const first = gate(),
    second = gate();
  const f = fixture(async (u) => {
    if (u.update_id === 10) {
      await first.promise;
    }
    if (u.update_id === 20) {
      await second.promise;
    }
  }, 1);
  f.coordinator.observe([f.update(10), f.update(20), f.update(30, true)]);
  await turn();
  assert.equal(f.coordinator.status().waiting, 1);
  first.release();
  await turn();
  await f.coordinator.advance();
  assert.equal(f.store.state.botOffset, 11);
  assert.equal(f.coordinator.status().observed, 2);
  second.release();
  await f.coordinator.idle();
  await f.coordinator.advance();
  assert.equal(f.store.state.botOffset, 31);
});
test('accepted queued commands finish during drain and lifecycle counts their wait', async () => {
  const first = gate(),
    done: number[] = [];
  const f = fixture(async (u) => {
    if (u.update_id === 1) {
      await first.promise;
    }
    done.push(u.update_id);
  });
  f.coordinator.observe([f.update(1), f.update(2)]);
  await turn();
  assert.equal(f.lifecycle.inFlight, 2);
  f.lifecycle.drain();
  f.coordinator.observe([f.update(3)]);
  assert.equal(f.coordinator.status().waiting, 1);
  first.release();
  await f.coordinator.idle();
  assert.deepEqual(done, [1, 2]);
  assert.equal(f.lifecycle.inFlight, 0);
  await f.coordinator.advance();
  assert.equal(f.store.state.botOffset, 3);
  f.lifecycle.activate();
  f.coordinator.observe([]);
  await f.coordinator.idle();
  await f.coordinator.advance();
  assert.deepEqual(done, [1, 2, 3]);
});
test('fast response delivery never owns polling and both fast slots are bounded', async () => {
  const held = gate();
  let started = 0;
  const f = fixture(async () => {
    started++;
    await held.promise;
  });
  f.coordinator.observe([f.update(1, true), f.update(2, true), f.update(3, true)]);
  await turn();
  assert.equal(started, 2);
  assert.equal(f.coordinator.status().observed, 3);
  held.release();
  await f.coordinator.idle();
  await f.coordinator.advance();
  assert.equal(started, 3);
  assert.equal(f.store.state.botOffset, 4);
});
test('failed durable handler prevents future acknowledgement instead of becoming a provider retry', async () => {
  const error = new OperationError('durability', 'fixture write failed');
  const f = fixture(async () => {
    throw error;
  });
  f.coordinator.observe([f.update(1)]);
  await assert.rejects(
    () => f.coordinator.idle(),
    (e) => e === error,
  );
  await assert.rejects(
    () => f.coordinator.advance(),
    (e) => e === error,
  );
  assert.equal(f.store.state.botOffset, 0);
});
function callback(id: number): BotUpdate {
  return {
    update_id: id,
    callback_query: {
      id: `callback-${id}`,
      from: { id: 1 },
      message: { chat: { id: 1, type: 'private' } },
      data: 'approve:draft',
    },
  };
}
test('callback answers bypass a saturated slow lane without reordering actions or repeated answers', async () => {
  const slow = gate(),
    actions: number[] = [],
    answered: string[] = [];
  const f = fixture(
    async (u) => {
      if (u.update_id === 1) {
        await slow.promise;
      }
      actions.push(u.update_id);
    },
    1,
    async (id) => {
      answered.push(id);
    },
  );
  try {
    f.coordinator.observe([f.update(1), callback(2), callback(3)]);
    await turn();
    f.coordinator.observe([f.update(1), callback(2), callback(3)]);
    await turn();
    await f.coordinator.advance();
    assert.deepEqual(answered, ['callback-2', 'callback-3']);
    assert.deepEqual(actions, []);
    assert.equal(f.store.state.botOffset, 0);
  } finally {
    slow.release();
    await f.coordinator.idle();
  }
  await f.coordinator.advance();
  assert.deepEqual(actions, [1, 2, 3]);
  assert.equal(f.store.state.botOffset, 4);
});
test('callback answer work is bounded and tracked during drain even after action completion', async () => {
  const held = gate(),
    answered: string[] = [];
  const f = fixture(
    async () => {},
    32,
    async (id) => {
      answered.push(id);
      await held.promise;
    },
  );
  f.coordinator.observe(Array.from({ length: 100 }, (_, i) => callback(i + 1)));
  await turn();
  f.lifecycle.drain();
  try {
    assert.equal(answered.length, 4);
    assert.equal(f.lifecycle.inFlight, 4);
    await f.coordinator.advance();
    assert.equal(f.store.state.botOffset, 0);
    assert.equal(f.coordinator.status().observed, 100);
  } finally {
    held.release();
    await f.coordinator.idle();
    f.lifecycle.activate();
    f.coordinator.observe([]);
    await f.coordinator.idle();
  }
  await f.coordinator.advance();
  assert.equal(answered.length, 100);
  assert.equal(f.store.state.botOffset, 101);
});
test('deadline cancels real work but waits its cleanup before resolving the operation', async () => {
  const closing = gate();
  let abortSeen = false,
    settled = false;
  const job = withOperation('request', 10, undefined, async (ctx) => {
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener(
        'abort',
        () => {
          abortSeen = true;
          resolve();
        },
        { once: true },
      );
    });
    await closing.promise;
  });
  const observed = job.then(
    () => {
      settled = true;
    },
    (e) => {
      settled = true;
      assert.equal(e.kind, 'deadline');
    },
  );
  await new Promise((r) => {
    setTimeout(r, 25);
  });
  assert.equal(abortSeen, true);
  assert.equal(settled, false);
  closing.release();
  await observed;
  assert.equal(settled, true);
});
test('parent cancellation propagates and operation telemetry is removed on disposal', () => {
  const controller = new AbortController();
  const ctx = createOperation('source', 1000, controller.signal);
  assert.ok(activeOperations().some((x) => x.id === ctx.id));
  controller.abort(new OperationError('cancelled', 'drain', 'drain'));
  assert.throws(() => ctx.throwIfAborted(), /drain/);
  ctx.dispose();
  assert.equal(
    activeOperations().some((x) => x.id === ctx.id),
    false,
  );
});
test('native abort errors preserve deadline identity without masking a concurrent durability failure', async () => {
  const keeper = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      withOperation(
        'request',
        10,
        undefined,
        (ctx) =>
          new Promise((_, reject) => {
            ctx.signal.addEventListener(
              'abort',
              () => reject(new DOMException('native request aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
      (e) => e instanceof OperationError && e.kind === 'deadline',
    );
    const error = new OperationError('durability', 'fixture fsync');
    await assert.rejects(
      withOperation(
        'request',
        10,
        undefined,
        (ctx) =>
          new Promise((_, reject) => {
            ctx.signal.addEventListener('abort', () => reject(error), { once: true });
          }),
      ),
      (e) => e === error,
    );
  } finally {
    clearTimeout(keeper);
  }
});
test('IPC notice persistence rejection reports controlled fatal and releases lifecycle scope', async () => {
  const life = new WorkerLifecycle(),
    messages: Record<string, unknown>[] = [];
  const ctl = new WorkerControl(
    life,
    'worker',
    {
      prepare: async () => {},
      activate: async () => {},
      checkpoint: async () => {},
      finish: async () => {},
      notice: async () => {
        throw Error('fixture save');
      },
      health: () => ({}),
    },
    (m) => messages.push(m),
  );
  const c = (type: string, sequence: number) => ({
    protocolVersion: 1,
    attemptId: 'attempt',
    workerId: 'worker',
    sequence,
    type,
  });
  try {
    await ctl.receive(c('prepare', 1));
    await ctl.receive(c('activate', 2));
    await assert.rejects(
      () => ctl.receive({ ...c('notice', 3), id: 'notice', text: 'fixture' }),
      /notice persistence/,
    );
    assert.equal(messages.at(-1)?.type, 'fatal');
    assert.equal(life.inFlight, 0);
  } finally {
    ctl.close();
  }
});
test('stale or foreign drain cannot trigger source cancellation after a validated resume', async () => {
  const life = new WorkerLifecycle();
  let source = new AbortController(),
    transitions = 0;
  const ctl = new WorkerControl(
    life,
    'worker',
    {
      prepare: async () => {},
      activate: async () => {},
      checkpoint: async () => {},
      finish: async () => {},
      notice: async () => {},
      health: () => ({}),
      transition: (mode) => {
        transitions++;
        if (mode === 'draining') {
          source.abort();
        } else if (mode === 'active') {
          source = new AbortController();
        }
      },
    },
    () => {},
  );
  const c = (type: string, sequence: number) => ({
    protocolVersion: 1,
    attemptId: 'attempt',
    workerId: 'worker',
    sequence,
    type,
  });
  try {
    await ctl.receive(c('prepare', 1));
    await ctl.receive(c('activate', 2));
    await ctl.receive(c('drain', 3));
    await ctl.receive(c('resume', 4));
    assert.equal(source.signal.aborted, false);
    const before = transitions;
    await ctl.receive(c('drain', 3));
    await ctl.receive({ ...c('drain', 5), workerId: 'foreign' });
    assert.equal(source.signal.aborted, false);
    assert.equal(life.mode, 'active');
    assert.equal(transitions, before);
  } finally {
    ctl.close();
  }
});
test('failed activation rejects into local shutdown rather than leaving an unresolved activation wait', async () => {
  const life = new WorkerLifecycle(),
    messages: Record<string, unknown>[] = [];
  const failure = new OperationError('durability', 'fixture activation write');
  const ctl = new WorkerControl(
    life,
    'worker',
    {
      prepare: async () => {},
      activate: async () => {
        throw failure;
      },
      checkpoint: async () => {},
      finish: async () => {},
      notice: async () => {},
      health: () => ({}),
    },
    (m) => messages.push(m),
  );
  const c = (type: string, sequence: number) => ({
    protocolVersion: 1,
    attemptId: 'attempt',
    workerId: 'worker',
    sequence,
    type,
  });
  try {
    await ctl.receive(c('prepare', 1));
    await assert.rejects(
      () => ctl.receive(c('activate', 2)),
      (e) => e === failure,
    );
    assert.equal(messages.at(-1)?.type, 'fatal');
  } finally {
    ctl.close();
  }
});
