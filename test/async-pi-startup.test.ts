import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiAssistant, modelRuntime } from '../src/pi.js';
import { Store } from '../src/store.js';
import { activeOperations, createOperation, OperationError, budgets } from '../src/operations.js';

test('Pi startup forwards cancellation and bounded refresh through the public ModelRuntime API', async (t) => {
  const ctx = createOperation('connect', budgets.connect);
  let entered!: () => void,
    settled = false;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.mock.method(
    ModelRuntime,
    'create',
    async (options: Parameters<typeof ModelRuntime.create>[0]) => {
      assert.equal(options?.allowModelNetwork, true);
      assert.ok(options?.signal);
      assert.ok(
        options.modelRefreshTimeoutMs! > 0 && options.modelRefreshTimeoutMs! <= budgets.connect,
      );
      entered();
      try {
        await new Promise<never>((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
            once: true,
          });
        });
      } finally {
        settled = true;
      }
      throw new Error('unreachable');
    },
  );
  const pi = new PiAssistant();
  const opening = pi.open(new Store('/unused'), 'fixture', [], undefined, ctx);
  const rejected = assert.rejects(
    opening,
    (error: unknown) => error instanceof OperationError && error.kind === 'cancelled',
  );
  try {
    await started;
    ctx.abort();
    await rejected;
    assert.equal(settled, true);
    assert.equal(pi.session, undefined);
  } finally {
    ctx.dispose();
  }
  assert.equal(activeOperations().length, 0);
});

test('already cancelled model initialization performs no SDK work', async (t) => {
  let calls = 0;
  t.mock.method(ModelRuntime, 'create', async () => {
    calls++;
    throw new Error('unexpected SDK call');
  });
  const ctx = createOperation('connect', budgets.connect);
  ctx.abort();
  try {
    await assert.rejects(modelRuntime(ctx));
    assert.equal(calls, 0);
  } finally {
    ctx.dispose();
  }
  assert.equal(activeOperations().length, 0);
});
