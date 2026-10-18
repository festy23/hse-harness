import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installRuntime, readRuntimeStatus, requestUpdate, updateSettings } from '../runtime/installation.mjs';
import { atomicJSON } from '../runtime/storage.mjs';

const project = resolve('.');
const manifest = { protocolVersion: 1, minSupervisorVersion: '1.0.0', stateSchemaVersion: 2,
  piVersion: '1.0.2', writableStateVersion: 2, formats: { operations: 2, auth: 1 } };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hse runtime installation '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const store = { npm: process.execPath, async prepare(version) {
    return { version, integrity: 'fixture', releasePath: join(home, 'runtime/releases/fixture'), packageRoot: project, manifest };
  }, async validate(release) { return release; } };
  return { home, store };
}

test('runtime status is read-only before configuration', async t => {
  const { home } = await fixture(t);
  assert.equal((await readRuntimeStatus(home)).runningVersion, undefined);
  await assert.rejects(access(home), { code: 'ENOENT' });
});

test('stable launcher lives outside npm root; repeated baseline setup retains disabled policy and data', async t => {
  const { home, store } = await fixture(t);
  await mkdir(join(home, 'data'), { recursive: true });
  const original = '{"queue":[{"id":"keep"}],"sessionPath":"keep.jsonl"}';
  await writeFile(join(home, 'data/operations.json'), original);
  await updateSettings(home, { enabled: false });
  const first = await installRuntime({ home, packageRoot: project, releaseStore: store });
  assert.equal(first.launcher, join(home, 'runtime/launcher.mjs'));
  const launcher = await readFile(first.launcher, 'utf8');
  assert.match(launcher, /engines\/1\.0\.1-/);
  assert.ok(!launcher.includes(project));
  await installRuntime({ home, packageRoot: project, releaseStore: store });
  assert.equal((await readRuntimeStatus(home)).updatesEnabled, false);
  assert.equal(await readFile(join(home, 'data/operations.json'), 'utf8'), original);
});

test('live legacy worker forbids baseline replacement before release preparation', async t => {
  const { home, store } = await fixture(t);
  await mkdir(join(home, 'data'), { recursive: true });
  await writeFile(join(home, 'data/service.lock'), String(process.pid));
  let prepared = false; store.prepare = async () => { prepared = true; throw new Error('unexpected'); };
  await assert.rejects(installRuntime({ home, packageRoot: project, releaseStore: store }), /уже работает/);
  assert.equal(prepared, false);
  assert.equal(await readFile(join(home, 'data/service.lock'), 'utf8'), String(process.pid));
});

test('settings changes preserve the request and runtime hold; requests are explicit identities', async t => {
  const { home } = await fixture(t);
  const request = await requestUpdate(home, { action: 'rollback' });
  await atomicJSON(join(home, 'runtime/state.json'), { manualHold: { version: '0.3.0' } });
  const enabled = await updateSettings(home, { enabled: true });
  assert.equal(enabled.request.id, request.request.id);
  assert.equal(JSON.parse(await readFile(join(home, 'runtime/state.json'), 'utf8')).manualHold.version, '0.3.0');
  assert.notEqual((await requestUpdate(home, { action: 'retry' })).request.id, request.request.id);
});

test('foreground restart retains the running baseline, rollback hold and interrupted transaction', async t => {
  const { home, store } = await fixture(t);
  await installRuntime({ home, packageRoot: project, releaseStore: store });
  const path = join(home, 'runtime/state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.manualHold = { version: '0.3.0', integrity: 'fixture' };
  state.attempt = { id: 'recover-me', phase: 'draining', from: state.active, to: { ...state.active, version: '0.3.0' } };
  await atomicJSON(path, state);
  let prepared;
  const prepare = store.prepare.bind(store);
  store.prepare = async version => { prepared = version; return prepare(version); };
  await installRuntime({ home, packageRoot: project, releaseStore: store });
  const after = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(after.active.version, state.active.version);
  assert.equal(after.manualHold.version, '0.3.0');
  assert.equal(after.attempt.id, 'recover-me');
  assert.equal(prepared, JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).version);
});

test('serviced engine upgrade uses verified installed release while preserving an older selected worker', async t => {
  const { home, store } = await fixture(t);
  await installRuntime({ home, packageRoot: project, releaseStore: store });
  const path = join(home, 'runtime/state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  const oldRoot = join(home, 'old-worker');
  await mkdir(join(oldRoot, 'runtime'), { recursive: true });
  await writeFile(join(oldRoot, 'runtime/supervisor.mjs'), 'export const oldEngine = true;');
  state.active = { ...state.active, version: '0.2.2', packageRoot: oldRoot };
  state.previous = { ...state.active, version: '0.2.1' };
  state.quarantine = [{ version: '0.2.4', integrity: 'fixture' }];
  state.manualHold = { version: '0.2.3' };
  state.attempt = { id: 'interrupted', phase: 'draining', from: state.active, to: state.previous };
  await atomicJSON(path, state);
  const installed = await installRuntime({ home, packageRoot: project, releaseStore: store });
  const after = JSON.parse(await readFile(path, 'utf8'));
  for (const field of ['active', 'previous', 'quarantine', 'manualHold', 'attempt']) assert.deepEqual(after[field], state[field]);
  const launcher = await readFile(installed.launcher, 'utf8');
  const engine = /from "(\.\/engines\/[^\"]+\/supervisor\.mjs)"/.exec(launcher)?.[1];
  assert.ok(engine);
  assert.match(await readFile(join(home, 'runtime', engine), 'utf8'), /SUPERVISOR_VERSION = '1\.0\.1'/);
});

test('installation refuses a symlink runtime without writing its destination', async t => {
  const { home, store } = await fixture(t);
  await mkdir(home); const outside = join(home, '..', 'outside'); await mkdir(outside);
  await symlink(outside, join(home, 'runtime'));
  await assert.rejects(installRuntime({ home, packageRoot: project, releaseStore: store }), /directory/);
  await assert.rejects(access(join(outside, 'state.json')), { code: 'ENOENT' });
});

test('failed verification of installed engine leaves selected release and launcher intact', async t => {
  const { home, store } = await fixture(t);
  const installed = await installRuntime({ home, packageRoot: project, releaseStore: store });
  const journalPath = join(home, 'runtime/state.json');
  const before = await readFile(journalPath, 'utf8'), launcher = await readFile(installed.launcher, 'utf8');
  store.prepare = async () => { throw new Error('installed engine verification failed'); };
  await assert.rejects(installRuntime({ home, packageRoot: project, releaseStore: store }), /verification failed/);
  assert.equal(await readFile(journalPath, 'utf8'), before);
  assert.equal(await readFile(installed.launcher, 'utf8'), launcher);
});
