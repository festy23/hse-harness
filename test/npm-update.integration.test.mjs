import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { inventoryTree, fileIdentity, PACKAGE_NAME } from '../runtime/manifest.mjs';
import { ReleaseStore, runInstaller } from '../runtime/releases.mjs';
import { Supervisor } from '../runtime/supervisor.mjs';
import { atomicJSON, readJSON } from '../runtime/storage.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.HSE_TEST_NPM || execFileSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await wait(100); }
  throw new Error('npm update integration timed out');
}

async function archiveCopy(packageRoot, target) {
  const entries = await inventoryTree(packageRoot);
  async function* tar() {
    for (const entry of entries) {
      const header = Buffer.alloc(512); const path = 'package/' + entry.path;
      let name = path; let prefix = '';
      if (Buffer.byteLength(path) > 100) {
        const split = path.lastIndexOf('/', Math.min(path.length - 1, 155));
        prefix = path.slice(0, split); name = path.slice(split + 1);
      }
      if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('fixture archive name exceeds USTAR bounds');
      header.write(name, 0, 100); header.write((entry.mode || 0o755).toString(8).padStart(7, '0'), 100, 7);
      header.write('0000000', 108, 7); header.write('0000000', 116, 7);
      const bytes = entry.type === 'file' ? await readFile(join(packageRoot, entry.path)) : Buffer.alloc(0);
      header.write(bytes.length.toString(8).padStart(11, '0'), 124, 11); header.write('00000000000', 136, 11);
      header.fill(32, 148, 156); header.write(entry.type === 'symlink' ? '2' : '0', 156, 1);
      if (entry.type === 'symlink') { if (Buffer.byteLength(entry.target) > 100) throw new Error('fixture link exceeds USTAR bounds'); header.write(entry.target, 157, 100); }
      header.write('ustar\0', 257, 6); header.write('00', 263, 2); header.write(prefix, 345, 155);
      header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
      yield header; if (bytes.length) yield bytes;
      if (bytes.length % 512) yield Buffer.alloc(512 - bytes.length % 512);
    }
    yield Buffer.alloc(1024);
  }
  // Every regular file gets its own tar entry: copying an already bundled tree and
  // running npm pack again may synthesize hard links for repeated bin identities.
  await pipeline(Readable.from(tar()), createGzip({ level: 1 }), createWriteStream(target));
}

// A fixture protocol worker replaces only copied main.js. Every remaining compiled
// app module and the entire published runtime dependency tree are the actual project.
// ReleaseStore still imports the real Pi SDK and executes the real esbuild binary.
test('real npm update between two complete project archives switches immutable workers without manual restart', { timeout: 600000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'hse npm update integration '));
  let supervisor; let running; let server;
  t.after(async () => {
    if (supervisor) { supervisor.requestStop(); await running?.catch(() => {}); }
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  const home = join(temporary, 'agent home'); await mkdir(home, { mode: 0o700 });
  const store = new ReleaseStore(home, { npm, timeout: 120000 });
  const tooling = join(temporary, 'tooling'); await mkdir(tooling);
  for (const path of ['npm-home', 'tmp', 'npm-cache']) await mkdir(join(tooling, path));
  await writeFile(join(tooling, 'empty-npmrc'), ''); await writeFile(join(tooling, 'empty-global-npmrc'), '');
  const env = store.installerEnvironment(tooling);
  const packed = join(temporary, 'packed'); await mkdir(packed);
  const sourceArchive = (await runInstaller(npm, ['pack', '--ignore-scripts', '--loglevel=error', '--pack-destination', packed], { cwd: root, env, timeout: 120000 })).trim();
  const extracted = join(temporary, 'extracted'); await mkdir(extracted);
  execFileSync('tar', ['-xzf', join(packed, sourceArchive), '-C', extracted]);
  const copiedRoot = join(extracted, 'package');
  const sourceManifest = await readJSON(join(copiedRoot, 'runtime-manifest.json'));
  const metadata = await readJSON(join(copiedRoot, 'package.json'));
  const fixtureSource = await readFile(new URL('./fixtures/update-worker.mjs', import.meta.url), 'utf8');
  const timedFixture = fixtureSource.replace('JSON.stringify({ type, version, pid: process.pid, ...more })', 'JSON.stringify({ at: Date.now(), type, version, pid: process.pid, ...more })');
  assert.notEqual(timedFixture, fixtureSource, 'fixture event shape must be instrumented');
  await writeFile(join(copiedRoot, 'dist/main.js'), timedFixture);
  await writeFile(join(copiedRoot, 'fixture.json'), '{}');
  // Inventory the frozen copy, not the mutable development tree while other
  // implementation agents may still be editing first-party modules.
  const referenceInventory = (await inventoryTree(copiedRoot)).filter(entry => entry.path !== 'runtime-manifest.json');
  const versions = new Map();
  for (const version of ['0.2.0', '0.2.1']) {
    metadata.version = version;
    metadata.files = [...new Set([...metadata.files, 'fixture.json'])];
    await writeFile(join(copiedRoot, 'package.json'), JSON.stringify(metadata));
    const changed = new Set(['package.json', 'dist/main.js', 'fixture.json']);
    const manifest = { ...sourceManifest, version, inventory: referenceInventory.filter(entry => !changed.has(entry.path)) };
    for (const path of changed) manifest.inventory.push(await fileIdentity(copiedRoot, path));
    await writeFile(join(copiedRoot, 'runtime-manifest.json'), JSON.stringify(manifest));
    const filename = 'fixture-' + version + '.tgz';
    await archiveCopy(copiedRoot, join(packed, filename));
    const archive = await readFile(join(packed, filename));
    versions.set(version, { archive, metadata: structuredClone(metadata), integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') });
  }
  t.diagnostic('Complete fixture archives ready');
  let latest = '0.2.0';
  server = createServer((req, res) => {
    const tarVersion = /^\/release-(0\.2\.[01])\.tgz$/.exec(req.url)?.[1];
    if (tarVersion) { const archive = versions.get(tarVersion).archive; res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.length }); res.end(archive); return; }
    const registryURL = `http://127.0.0.1:${server.address().port}/`;
    const record = version => ({ ...versions.get(version).metadata, dist: { integrity: versions.get(version).integrity, tarball: registryURL + 'release-' + version + '.tgz' } });
    const exact = /\/(0\.2\.[01])$/.exec(req.url)?.[1];
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(exact ? record(exact) : { name: PACKAGE_NAME, 'dist-tags': { latest }, versions: Object.fromEntries([...versions.keys()].map(v => [v, record(v)])) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const registry = `http://127.0.0.1:${server.address().port}/`;
  const prefix = join(temporary, 'global prefix'); await mkdir(prefix);
  const prefixManifest = join(prefix, 'lib/node_modules', PACKAGE_NAME, 'package.json');
  await runInstaller(npm, ['install', '--global', '--prefix', prefix, PACKAGE_NAME + '@0.2.0', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=' + registry], { cwd: tooling, env: { ...env, npm_config_registry: registry }, timeout: 120000 });
  const releaseStore = new ReleaseStore(home, { npm, registry, timeout: 120000 });
  const baseline = await releaseStore.prepare('0.2.0');
  t.diagnostic('Verified immutable baseline prepared with real SDK and esbuild');
  const operations = JSON.stringify({ schemaVersion: 2, queue: [{ id: 'owner:123', text: 'unchanged pending task' }], approvals: [{ id: 'approved-1', randomId: '1234567', state: 'approved' }], delivered: { reminder: true } });
  const piJSONL = '{"type":"session","version":3,"id":"test-preserved"}\n{"type":"message","message":{"role":"user","content":"keep this turn"}}\n';
  await mkdir(join(home, 'data/sessions'), { recursive: true });
  await writeFile(join(home, 'data/operations.json'), operations); await writeFile(join(home, 'data/sessions/session.jsonl'), piJSONL);
  await atomicJSON(join(home, 'runtime/settings.json'), { enabled: true });
  await atomicJSON(join(home, 'runtime/state.json'), { schemaVersion: 1, installation: { manifestPath: prefixManifest, npm }, active: baseline, previous: null, attempt: null, quarantine: [] });
  const state = () => readJSON(join(home, 'runtime/state.json'));
  supervisor = new Supervisor(home, { releaseStore, pollMs: 50, debounce: 3, probationMs: 200, drainMs: 5000, bootMs: 10000, finishMs: 5000, heartbeatMs: 30000, stdio: 'ignore' });
  running = supervisor.run(); running.catch(() => {});
  await eventually(async () => (await state()).runningVersion === '0.2.0');
  t.diagnostic('Baseline worker active');
  const initialWorkerPid = supervisor.worker.child.pid;
  const initialSupervisorPid = (await state()).supervisorPid;
  latest = '0.2.1';
  // This is the user's actual update command, isolated from their own npm prefix.
  await runInstaller(npm, ['update', '--global', '--prefix', prefix, PACKAGE_NAME, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=' + registry], { cwd: tooling, env: { ...env, npm_config_registry: registry }, timeout: 120000 });
  assert.equal((await readJSON(prefixManifest)).version, '0.2.1');
  t.diagnostic('Actual npm update installed 0.2.1');
  await eventually(async () => { const s = await state(); if (s.phase === 'deferred') throw new Error('Update deferred: ' + s.deferredReason); return s.active?.version === '0.2.1' && !s.attempt; });
  const final = await state(); assert.equal(final.supervisorPid, initialSupervisorPid); assert.equal(final.runningVersion, '0.2.1'); assert.equal(final.previous.version, '0.2.0');
  assert.notEqual(supervisor.worker.child.pid, initialWorkerPid);
  assert.ok(supervisor.worker.release.packageRoot.startsWith(join(home, 'runtime/releases'))); assert.ok(!supervisor.worker.release.packageRoot.startsWith(prefix));
  assert.equal(await readFile(join(home, 'data/operations.json'), 'utf8'), operations); assert.equal(await readFile(join(home, 'data/sessions/session.jsonl'), 'utf8'), piJSONL);
  const events = (await readFile(join(home, 'fixture.events'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.some(event => event.type === 'overlap'), false);
  assert.ok(events.findIndex(event => event.version === '0.2.0' && event.type === 'finished') < events.findIndex(event => event.version === '0.2.1' && event.type === 'activate'));
  const stoppedAt = events.find(event => event.version === '0.2.0' && event.type === 'finished').at;
  const activatedAt = events.find(event => event.version === '0.2.1' && event.type === 'activate').at;
  const pauseMs = activatedAt - stoppedAt;
  assert.ok(Number.isFinite(pauseMs) && pauseMs >= 0 && pauseMs <= 15000, `local process switch pause ${pauseMs}ms exceeds 15000ms target`);
  t.diagnostic(`Measured local process switch pause: ${pauseMs}ms (target <=15000ms)`);
  assert.equal(await readFile(join(home, 'fixture.data'), 'utf8'), '0.2.0\n0.2.1\n');
  await access(join(final.active.releasePath, 'COMPLETE')); await access(join(final.previous.releasePath, 'COMPLETE'));
});
