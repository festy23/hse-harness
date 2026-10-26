import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime, SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { PiAssistant } from '../src/pi.js';
import { Store } from '../src/store.js';
import { OperationError, fatal } from '../src/operations.js';

const fixtureError = () =>
  Object.assign(new Error('private fixture contents must not appear in the routed error'), {
    code: 'EIO',
  });
function durability(error: unknown): boolean {
  assert.ok(error instanceof OperationError);
  assert.equal(error.kind, 'durability');
  assert.equal(fatal(error), true);
  assert.ok(!error.message.includes('private fixture'));
  return true;
}
function assistant(pi: PiAssistant, prompt: () => Promise<void> = async () => {}): void {
  pi.session = {
    subscribe: () => () => {},
    prompt,
    messages: [],
    getLastAssistantText: () => 'Fixture answer',
  } as unknown as AgentSession;
}

test('actual checkpoint file fsync failure becomes sticky durability and closes its real handle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-checkpoint-failure-')),
    path = join(dir, 'fixture.jsonl');
  await writeFile(path, 'fixture');
  const originalOpen = fs.open;
  let closed = false,
    attempts = 0;
  const pi = new PiAssistant();
  pi.manager = { getSessionFile: () => path } as SessionManager;
  try {
    fs.open = async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (String(file) !== path) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'sync') {
            return async () => {
              attempts++;
              throw fixtureError();
            };
          }
          if (key === 'close') {
            return async () => {
              try {
                await target.close();
              } finally {
                closed = true;
              }
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    syncBuiltinESMExports();
    await assert.rejects(pi.checkpoint(), durability);
    assert.equal(closed, true);
    assert.equal(attempts, 1);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
  await assert.rejects(pi.checkpoint(), durability);
  assert.equal(attempts, 1);
});

test('operation-start append failure is fatal before a model request', async (t) => {
  const pi = new PiAssistant();
  pi.manager = SessionManager.inMemory();
  let requests = 0;
  assistant(pi, async () => {
    requests++;
  });
  t.mock.method(pi.manager, 'appendCustomEntry', () => {
    throw fixtureError();
  });
  await assert.rejects(pi.prompt('Fixture'), durability);
  assert.equal(requests, 0);
});

test('operation-result append failure is fatal rather than a successful answer', async (t) => {
  const pi = new PiAssistant();
  pi.manager = SessionManager.inMemory();
  assistant(pi);
  const append = pi.manager.appendCustomEntry.bind(pi.manager);
  t.mock.method(pi.manager, 'appendCustomEntry', (kind: string, data: unknown) => {
    if (kind === 'hse-operation-result') {
      throw fixtureError();
    }
    return append(kind, data);
  });
  await assert.rejects(pi.prompt('Fixture'), durability);
});

test('SDK message persistence failure remains fatal when its caller catches the append exception', async (t) => {
  const pi = new PiAssistant();
  pi.manager = SessionManager.inMemory();
  let swallowed = false;
  t.mock.method(pi.manager, 'appendMessage', () => {
    throw fixtureError();
  });
  assistant(pi, async () => {
    try {
      pi.manager.appendMessage({ role: 'user', content: 'Fixture original entry', timestamp: 1 });
    } catch {
      swallowed = true;
    }
  });
  await assert.rejects(pi.prompt('Fixture'), durability);
  assert.equal(swallowed, true);
  await assert.rejects(pi.completedTurn('unknown'), durability);
});

test('recovered-result and seed append failures route through durability', async (t) => {
  const recovered = new PiAssistant();
  recovered.manager = SessionManager.inMemory();
  recovered.manager.appendCustomEntry('hse-operation-start', { turnId: 'fixture' });
  recovered.manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'Fixture recovered answer' }],
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
    timestamp: 1,
  });
  t.mock.method(recovered.manager, 'appendCustomEntry', () => {
    throw fixtureError();
  });
  await assert.rejects(recovered.completedTurn('fixture'), durability);
  const seeded = new PiAssistant();
  seeded.manager = SessionManager.inMemory();
  t.mock.method(seeded.manager, 'appendCustomMessageEntry', () => {
    throw fixtureError();
  });
  await assert.rejects(seeded.seed(), durability);
});

test('an unreadable existing session path is a local invariant failure', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-local-state-'));
  const runtime = {
    isUsingSubscription: () => true,
    getModel: () => ({ id: 'fixture' }),
  } as unknown as ModelRuntime;
  t.mock.method(ModelRuntime, 'create', async () => runtime);
  const store = new Store(dir);
  store.state.sessionPath = dir;
  try {
    await assert.rejects(
      new PiAssistant().open(store, 'fixture', []),
      (error: unknown) =>
        error instanceof OperationError && error.kind === 'invariant' && fatal(error),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SessionManager create failure is a local invariant, while model transport errors stay retryable', async (t) => {
  const runtime = {
    isUsingSubscription: () => true,
    getModel: () => ({ id: 'fixture' }),
  } as unknown as ModelRuntime;
  t.mock.method(ModelRuntime, 'create', async () => runtime);
  t.mock.method(SessionManager, 'create', () => {
    throw fixtureError();
  });
  await assert.rejects(
    new PiAssistant().open(new Store('/unused'), 'fixture', []),
    (error: unknown) =>
      error instanceof OperationError && error.kind === 'invariant' && fatal(error),
  );
  const pi = new PiAssistant();
  pi.manager = SessionManager.inMemory();
  const transport = new Error('Fixture provider disconnected');
  assistant(pi, async () => {
    throw transport;
  });
  await assert.rejects(pi.prompt('Fixture'), (error) => error === transport && !fatal(error));
});
