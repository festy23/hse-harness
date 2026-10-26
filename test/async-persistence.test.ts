import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { OperationError, createOperation } from '../src/operations.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test('snapshot batches cover requested revisions without resolving later saves before their durable write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'batched-store-'));
  class PausedStore extends Store {
    snapshots: string[] = [];
    gates: ReturnType<typeof deferred>[] = [];
    protected override async persistSnapshot(snapshot: string) {
      this.snapshots.push(snapshot);
      const gate = deferred();
      this.gates.push(gate);
      await gate.promise;
      await super.persistSnapshot(snapshot);
    }
  }
  const store = new PausedStore(dir);
  await store.load();
  try {
    store.state.notices.a = 'one';
    let firstDone = false,
      secondDone = false;
    const first = store.save().then(() => {
      firstDone = true;
    });
    store.state.notices.b = 'two';
    const coalesced = store.save();
    await new Promise<void>((r) => {
      setImmediate(r);
    });
    assert.equal(store.snapshots.length, 1);
    assert.equal(JSON.parse(store.snapshots[0]!).notices.b, 'two');
    store.state.notices.c = 'three';
    const second = store.save().then(() => {
      secondDone = true;
    });
    store.state.notices.d = 'four';
    const pendingBatch = store.save();
    assert.equal(firstDone, false);
    assert.equal(secondDone, false);
    store.gates[0]!.resolve();
    await Promise.all([first, coalesced]);
    assert.equal(firstDone, true);
    assert.equal(secondDone, false);
    assert.equal(store.snapshots.length, 2);
    assert.equal(
      JSON.parse(await readFile(join(dir, 'operations.json'), 'utf8')).notices.c,
      undefined,
    );
    const flushing = store.flush();
    store.gates[1]!.resolve();
    await Promise.all([second, pendingBatch, flushing]);
    const persisted = JSON.parse(await readFile(join(dir, 'operations.json'), 'utf8'));
    assert.deepEqual(persisted.notices, { a: 'one', b: 'two', c: 'three', d: 'four' });
    assert.equal(store.snapshots.length, 2);
  } finally {
    for (const gate of store.gates) {
      gate.resolve();
    }
    await store.flush();
    await rm(dir, { recursive: true, force: true });
  }
});

test('writer failure rejects the whole batch, latches fatal durability, and cannot be hidden by a later save', async () => {
  class FailedStore extends Store {
    writes = 0;
    protected override async persistSnapshot() {
      this.writes++;
      throw new Error('injected fsync failure');
    }
  }
  const store = new FailedStore('/unused');
  const one = store.save(),
    two = store.save();
  const fatal = (error: unknown) => error instanceof OperationError && error.kind === 'durability';
  await Promise.all([assert.rejects(one, fatal), assert.rejects(two, fatal)]);
  await assert.rejects(store.flush(), fatal);
  await assert.rejects(store.save(), fatal);
  assert.equal(store.writes, 1);
});

test('real snapshot write, file fsync, rename and directory fsync failures reject every durability barrier', async (t) => {
  for (const boundary of ['writeFile', 'file.sync', 'rename', 'directory.sync'] as const) {
    await t.test(boundary, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'store-boundary-')),
        path = join(dir, 'operations.json');
      const store = new Store(dir);
      await store.load();
      store.state.notices.baseline = 'already durable';
      await store.save();
      const baseline = await readFile(path, 'utf8');
      const originalOpen = fs.open,
        originalRename = fs.rename;
      const entered = deferred(),
        release = deferred();
      const stages: string[] = [],
        closed: string[] = [];
      const promises: Promise<unknown>[] = [];
      let faults = 0;
      const fail = async () => {
        faults++;
        entered.resolve();
        await release.promise;
        throw Object.assign(new Error(`Injected ${boundary} failure`), { code: 'EIO' });
      };
      const outcome = (error: unknown) =>
        error instanceof OperationError && error.kind === 'durability';
      let latched: unknown;
      try {
        fs.open = async (file, flags, mode) => {
          const handle = await originalOpen(file, flags, mode);
          const name = String(file),
            temporary = name.startsWith(path + '.'),
            directory = name === dir;
          if (!temporary && !directory) {
            return handle;
          }
          return new Proxy(handle, {
            get(target, key) {
              if (key === 'writeFile' && temporary) {
                return async (...args: Parameters<typeof handle.writeFile>) => {
                  stages.push('writeFile');
                  if (boundary === 'writeFile') {
                    await fail();
                  }
                  return target.writeFile(...args);
                };
              }
              if (key === 'sync') {
                return async () => {
                  const stage = directory ? 'directory.sync' : 'file.sync';
                  stages.push(stage);
                  if (boundary === stage) {
                    await fail();
                  }
                  return target.sync();
                };
              }
              if (key === 'close') {
                return async () => {
                  try {
                    await target.close();
                  } finally {
                    closed.push(directory ? 'directory' : 'file');
                  }
                };
              }
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        };
        fs.rename = async (from, to) => {
          if (String(from).startsWith(path + '.') && String(to) === path) {
            stages.push('rename');
            if (boundary === 'rename') {
              await fail();
            }
            await originalRename(from, to);
            stages.push('renamed');
            return;
          }
          return originalRename(from, to);
        };
        syncBuiltinESMExports();
        store.state.notices.first = 'candidate snapshot';
        const first = store.save();
        store.state.notices.coalesced = 'same batch';
        const coalesced = store.save(),
          firstFlush = store.flush();
        promises.push(first, coalesced, firstFlush);

        const firstResults = Promise.allSettled([first, coalesced, firstFlush]);
        await entered.promise;
        const visibleBeforeFailure = await readFile(path, 'utf8');
        if (boundary === 'directory.sync') {
          assert.notEqual(
            visibleBeforeFailure,
            baseline,
            'rename has made the candidate visible, but it is not yet confirmed durable',
          );
          assert.equal(JSON.parse(visibleBeforeFailure).notices.first, 'candidate snapshot');
        } else {
          assert.equal(
            visibleBeforeFailure,
            baseline,
            'a failure before successful rename must preserve the previous snapshot',
          );
        }
        store.state.notices.pending = 'next revision';
        const pending = store.save(),
          pendingFlush = store.flush();
        promises.push(pending, pendingFlush);
        const pendingResults = Promise.allSettled([pending, pendingFlush]);
        release.resolve();
        for (const result of [...(await firstResults), ...(await pendingResults)]) {
          assert.equal(result.status, 'rejected');
          if (result.status !== 'rejected') {
            continue;
          }
          assert.ok(outcome(result.reason));
          latched ??= result.reason;
          assert.equal(result.reason, latched);
        }
        assert.equal(faults, 1, 'the failed writer must not start the pending snapshot');
        assert.ok(
          closed.includes('file'),
          'the temporary file handle closes even after a failed write or fsync',
        );
        if (boundary === 'directory.sync') {
          assert.ok(stages.includes('renamed'));
          assert.ok(closed.includes('directory'));
        } else {
          assert.ok(!stages.includes('renamed'));
        }
        const visibleAfterFailure = await readFile(path, 'utf8');
        assert.equal(visibleAfterFailure, visibleBeforeFailure);
        assert.equal(JSON.parse(visibleAfterFailure).notices.pending, undefined);
      } finally {
        release.resolve();
        await Promise.allSettled(promises);
        fs.open = originalOpen;
        fs.rename = originalRename;
        syncBuiltinESMExports();
        try {
          if (latched) {
            await assert.rejects(store.save(), (error) => error === latched);
            await assert.rejects(store.flush(), (error) => error === latched);
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    });
  }
});

test('owner receipt is durable without acknowledging an earlier outstanding command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owner-floor-'));
  const store = new Store(dir);
  await store.load();
  try {
    store.state.botOffset = 5;
    await store.enqueueOwner('later owner text', 10);
    assert.equal(store.state.botOffset, 5);
    const reopened = new Store(dir);
    await reopened.load();
    assert.equal(reopened.state.botOffset, 5);
    assert.equal(reopened.state.ownerUpdates['10'], true);
    await reopened.enqueueOwner('duplicate', 10);
    assert.equal(reopened.state.queue.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancelled cooperative enqueue publishes neither seen receipts nor partial source pieces', async () => {
  const store = new Store('/unused');
  const ctx = createOperation('source', 1000);
  ctx.abort();
  try {
    await assert.rejects(
      store.enqueue(
        [{ id: 'fixture', kind: 'mail', text: 'source'.repeat(10000), date: '2026-10-01' }],
        ctx,
      ),
    );
    assert.deepEqual(store.state.seen, {});
    assert.deepEqual(store.state.queue, []);
  } finally {
    ctx.dispose();
  }
});
