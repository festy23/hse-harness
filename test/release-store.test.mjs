import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  cp,
  rm,
  lstat,
  symlink,
  readdir,
  chmod,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { ReleaseStore, runInstaller, inspectArchive } from '../runtime/releases.mjs';
import { atomicJSON, readJSON, acquireLock, safePath } from '../runtime/storage.mjs';
import {
  PACKAGE_NAME,
  ESBUILD_POLICY,
  PI_VERSION,
  assertManifest,
  inventoryTree,
  sha256,
  verifyInventory,
} from '../runtime/manifest.mjs';

const root = resolve(new URL('../', import.meta.url).pathname);
const npm =
  process.env.HSE_TEST_NPM ||
  execFileSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
const manifest = (version) => ({
  format: 1,
  packageName: PACKAGE_NAME,
  version,
  protocolVersion: 1,
  minSupervisorVersion: '1.0.0',
  stateSchemaVersion: 2,
  readableStateVersions: [1, 2],
  writableStateVersion: 2,
  formats: { operations: 2, approvals: 1, calendar: 1, auth: 1, pi: PI_VERSION },
  piVersion: PI_VERSION,
  engines: { node: '>=22.19.0' },
  platforms: Object.keys(ESBUILD_POLICY.platforms),
  esbuild: ESBUILD_POLICY,
  dependencies: [],
});

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'hse release store '));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function fixtures(t, version = '0.1.1', { incorrectCLI = false } = {}) {
  const path = await temporary(t);
  const packageRoot = join(path, 'package');
  await mkdir(packageRoot);
  await cp(join(root, 'node_modules/esbuild'), join(packageRoot, 'node_modules/esbuild'), {
    recursive: true,
  });
  await cp(
    join(root, 'node_modules/@esbuild', process.platform + '-' + process.arch),
    join(packageRoot, 'node_modules/@esbuild', process.platform + '-' + process.arch),
    { recursive: true },
  );
  const sdk = join(packageRoot, 'node_modules/@earendil-works/pi-coding-agent');
  await mkdir(join(sdk, 'dist'), { recursive: true });
  await writeFile(
    join(sdk, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: PI_VERSION,
      type: 'module',
      main: 'dist/index.js',
    }),
  );
  await writeFile(join(sdk, 'dist/index.js'), 'export const fixture = true;\n');
  await mkdir(join(packageRoot, 'dist'));
  await writeFile(join(packageRoot, 'dist/main.js'), 'export const worker = true;\n');
  const pkg = {
    name: PACKAGE_NAME,
    version,
    engines: { node: '>=22.19.0' },
    type: 'module',
    dependencies: {
      esbuild: ESBUILD_POLICY.version,
      '@earendil-works/pi-coding-agent': PI_VERSION,
    },
    bundleDependencies: ['esbuild', '@earendil-works/pi-coding-agent'],
  };
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(pkg));
  if (incorrectCLI) {
    await writeFile(join(packageRoot, 'node_modules/esbuild/bin/esbuild'), '#!/bin/sh\nexit 91\n', {
      mode: 0o755,
    });
  }
  const releaseManifest = { ...manifest(version), inventory: await inventoryTree(packageRoot) };
  releaseManifest.dependencies = [
    { path: 'node_modules/esbuild', name: 'esbuild', version: ESBUILD_POLICY.version },
    {
      path: 'node_modules/@earendil-works/pi-coding-agent',
      name: '@earendil-works/pi-coding-agent',
      version: PI_VERSION,
    },
  ];
  await writeFile(join(packageRoot, 'runtime-manifest.json'), JSON.stringify(releaseManifest));
  execFileSync(npm, ['pack', '--ignore-scripts', '--pack-destination', path], {
    cwd: packageRoot,
    stdio: 'pipe',
  });
  const archive = join(path, 'ivan-boss-hse-harness-' + version + '.tgz');
  return { path, packageRoot, version, bytes: await readFile(archive) };
}
async function registry(t, fixture, { badSRI = false } = {}) {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url === '/release.tgz') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': fixture.bytes.length,
      });
      res.end(fixture.bytes);
      return;
    }
    const integrity =
      'sha512-' +
      createHash('sha512')
        .update(badSRI ? Buffer.from('wrong') : fixture.bytes)
        .digest('base64');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        name: PACKAGE_NAME,
        version: fixture.version,
        engines: { node: '>=22.19.0' },
        dist: { integrity, tarball: `http://127.0.0.1:${server.address().port}/release.tgz` },
      }),
    );
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}/`, requests: () => requests };
}

test('journal is durable and private; locks cannot be stolen or released by a different owner', async (t) => {
  const home = await temporary(t);
  const state = join(home, 'runtime/state.json');
  await atomicJSON(state, { phase: 'preparing' });
  assert.deepEqual(await readJSON(state), { phase: 'preparing' });
  assert.equal((await lstat(state)).mode & 0o777, 0o600);
  const lockPath = join(home, 'runtime/supervisor.lock');
  const release = await acquireLock(lockPath);
  await assert.rejects(acquireLock(lockPath), /live or unverified/);
  await atomicJSON(lockPath, { pid: process.pid, ownerId: 'replacement' });
  assert.equal(await release(), false);
  assert.equal((await readJSON(lockPath)).ownerId, 'replacement');
});
test('unsafe paths, inventory symlinks and foreign release identities are rejected', async (t) => {
  const home = await temporary(t);
  const outside = await temporary(t);
  await writeFile(join(outside, 'code.js'), 'outside');
  await symlink(outside, join(home, 'external'));
  await assert.rejects(safePath(home, join(home, 'external/code.js')), /symbolic link/);
  await assert.rejects(
    verifyInventory(home, [
      {
        path: 'external/code.js',
        type: 'file',
        sha256: sha256(Buffer.from('outside')),
        mode: 0o644,
        size: 7,
      },
    ]),
    /symbolic link/,
  );
  await assert.rejects(
    new ReleaseStore(home, { npm }).validate({
      version: '0.1.1',
      integrity: 'sha512-' + createHash('sha512').update('test').digest('base64'),
      releasePath: outside,
    }),
    /identity/,
  );
  assert.throws(() => new ReleaseStore(home, { npm, registry: 'http://example.com/' }), /unsafe/);
});
test('manifest rejects incompatible state, Pi, engine, bootstrap and prereleases', () => {
  const valid = { ...manifest('0.1.1'), inventory: [{ path: 'dist/main.js' }] };
  assertManifest(valid, '0.1.1');
  for (const changed of [
    { piVersion: '2' },
    { protocolVersion: 2 },
    { stateSchemaVersion: 3 },
    { minSupervisorVersion: '2.0.0' },
    { writableStateVersion: 3 },
    { engines: { node: '>=99' } },
    { esbuild: { ...ESBUILD_POLICY, scriptSha256: 'bad' } },
    { version: '0.1.1-beta.1' },
  ]) {
    assert.throws(() => assertManifest({ ...valid, ...changed }, changed.version || '0.1.1'));
  }
});
test('supervisor patch accepts older stable minimums and rejects malformed or future requirements', () => {
  const valid = { ...manifest('0.1.1'), inventory: [{ path: 'dist/main.js' }] };
  for (const minimum of ['1.0.0', '1.0.1']) {
    assertManifest({ ...valid, minSupervisorVersion: minimum }, '0.1.1');
  }
  for (const minimum of ['1.0.2', '2.0.0', '1.0.1-beta', '01.0.0', undefined, 1]) {
    assert.throws(
      () => assertManifest({ ...valid, minSupervisorVersion: minimum }, '0.1.1'),
      /incompatible/,
    );
  }
});
test(
  'exact tarball is installed with real npm; identity reuse validates complete runtime and corruption',
  { timeout: 180000 },
  async (t) => {
    const fixture = await fixtures(t);
    const registryFixture = await registry(t, fixture);
    const home = await temporary(t);
    const store = new ReleaseStore(home, { npm, registry: registryFixture.url, timeout: 90000 });
    const release = await store.prepare(fixture.version);
    assert.equal(release.version, fixture.version);
    assert.match(release.releasePath, /0\.1\.1-[a-f0-9]{24}$/);
    assert.equal((await store.validate(release)).integrity, release.integrity);
    assert.equal((await readdir(join(home, 'runtime/staging'))).length, 0);
    const before = registryFixture.requests();
    const reused = await store.prepare(fixture.version);
    assert.equal(reused.releasePath, release.releasePath);
    assert.equal(registryFixture.requests(), before + 1, 'reuse only rechecks metadata');
    assert.equal((await store.collect([release])).removed.length, 0);
    await writeFile(join(release.packageRoot, 'dist/main.js'), 'tampered');
    await assert.rejects(store.validate(release), /inventory mismatch/);
    await assert.rejects(store.prepare(fixture.version), /inventory mismatch/);
    assert.equal((await store.collect([])).removed.length, 1);
  },
);
test('SRI mismatch never invokes npm and staging is removed', async (t) => {
  const fixture = { version: '0.1.1', bytes: Buffer.from('not a tarball') };
  const reg = await registry(t, fixture, { badSRI: true });
  const home = await temporary(t);
  const store = new ReleaseStore(home, { npm: '/no/npm', registry: reg.url });
  await assert.rejects(store.prepare('0.1.1'), /SRI mismatch/);
  assert.equal((await readdir(store.staging)).length, 0);
});
test('disk shortage preserves active files without downloading archive', async (t) => {
  const fixture = { version: '0.1.1', bytes: Buffer.from('unused') };
  const reg = await registry(t, fixture);
  const home = await temporary(t);
  const store = new ReleaseStore(home, { npm, registry: reg.url });
  store.diskAvailable = async () => 1;
  await assert.rejects(store.prepare('0.1.1'), /disk space/);
  assert.equal(reg.requests(), 1);
  assert.equal((await readdir(store.staging)).length, 0);
});
test('failed npm installation never leaves a COMPLETE release', async (t) => {
  const fixture = { version: '0.1.1', bytes: Buffer.from('invalid tar archive') };
  const reg = await registry(t, fixture);
  const home = await temporary(t);
  const store = new ReleaseStore(home, { npm, registry: reg.url, timeout: 15000 });
  await assert.rejects(store.prepare('0.1.1'), /installer failed|header check/);
  assert.equal((await readdir(store.releases)).length, 0);
  assert.equal((await readdir(store.staging)).length, 0);
});
test(
  'cancellation stops only the installer process group before returning',
  { timeout: 10000 },
  async (t) => {
    const home = await temporary(t);
    const script = join(home, 'installer.mjs');
    const childPid = join(home, 'child.pid');
    await writeFile(
      script,
      `import {spawn}from'node:child_process';import{writeFileSync}from'node:fs';const c=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'inherit'});writeFileSync(${JSON.stringify(childPid)},String(c.pid));process.on('SIGTERM',()=>{c.kill('SIGTERM');});setInterval(()=>{},100);`,
    );
    const controller = new AbortController();
    const operation = runInstaller(process.execPath, [script], {
      cwd: home,
      env: { PATH: process.env.PATH },
      signal: controller.signal,
      timeout: 5000,
    });
    while (true) {
      try {
        await access(childPid);
        break;
      } catch {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      }
    }
    const pid = Number(await readFile(childPid, 'utf8'));
    controller.abort();
    await assert.rejects(operation, { name: 'AbortError' });
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error.code === 'ESRCH',
    );
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  },
);
test(
  'installer timeout is bounded and does not expose output credentials',
  { timeout: 10000 },
  async (t) => {
    const home = await temporary(t);
    await assert.rejects(
      runInstaller(
        process.execPath,
        ['-e', "console.log('secret-test-token');setInterval(()=>{},50)"],
        { cwd: home, env: {}, timeout: 100 },
      ),
      (error) => /timed out/.test(error.message) && !error.message.includes('secret'),
    );
  },
);
test('cancellation during executable access prevents starting the installer', async (t) => {
  const home = await temporary(t),
    marker = join(home, 'started');
  const controller = new AbortController();
  const operation = runInstaller(
    process.execPath,
    ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
    { cwd: home, env: {}, signal: controller.signal },
  );
  queueMicrotask(() => controller.abort());
  await assert.rejects(operation, { name: 'AbortError' });
  await assert.rejects(access(marker), { code: 'ENOENT' });
});
test('GC protects all referenced releases and retains unknown symlinks', async (t) => {
  const home = await temporary(t);
  const store = new ReleaseStore(home, { npm });
  await store.initialize();
  const protectedPath = join(store.releases, '0.1.1-' + 'a'.repeat(24));
  const discarded = join(store.releases, '0.1.2-' + 'b'.repeat(24));
  await mkdir(protectedPath);
  await mkdir(discarded);
  const outside = await temporary(t);
  await writeFile(join(outside, 'keep'), 'safe');
  await symlink(outside, join(store.releases, 'unrecognized'));
  const result = await store.collect([{ releasePath: protectedPath }]);
  assert.deepEqual(result.removed, [discarded]);
  assert.equal(result.errors.length, 1);
  await access(join(outside, 'keep'));
  await access(protectedPath);
});

test('archive inspection bounds expansion and rejects traversal before extraction', async () => {
  const tar = (path) => {
    const header = Buffer.alloc(512);
    header.write(path);
    header.write('0000644', 100);
    header.write('00000000001', 124);
    header.write('0', 156);
    return gzipSync(Buffer.concat([header, Buffer.alloc(512), Buffer.alloc(1024)]));
  };
  await assert.rejects(inspectArchive(tar('package/../../outside')), /escapes/);
  await assert.rejects(
    inspectArchive(tar('package/good'), { maximumUnpackedBytes: 600 }),
    /size limit/,
  );
  await inspectArchive(tar('package/good'));
});
test('npm failure after partial writes cannot publish a release', { timeout: 30000 }, async (t) => {
  const fixture = await fixtures(t);
  const reg = await registry(t, fixture);
  const home = await temporary(t);
  const fakeNpm = join(home, 'npm-fixture');
  await writeFile(
    fakeNpm,
    '#!' +
      process.execPath +
      '\n' +
      "require('node:fs').writeFileSync('partial-install','partial');process.exit(17);\n",
    { mode: 0o755 },
  );
  const store = new ReleaseStore(home, { npm: fakeNpm, registry: reg.url, timeout: 15000 });
  await assert.rejects(store.prepare(fixture.version), /installer failed \(17\)/);
  assert.deepEqual(await readdir(store.releases), []);
  assert.deepEqual(await readdir(store.staging), []);
});

test(
  'audited bootstrap replaces a foreign CLI even when transform already works; explicit disabled policy defers',
  { timeout: 120000 },
  async (t) => {
    const fixture = await fixtures(t, '0.1.1', { incorrectCLI: true });
    const reg = await registry(t, fixture);
    const disabledHome = await temporary(t);
    const disabled = new ReleaseStore(disabledHome, { npm, registry: reg.url, bootstrap: false });
    await assert.rejects(disabled.prepare('0.1.1'), /platform preparation is disabled/);
    assert.deepEqual(await readdir(disabled.releases), []);
    const home = await temporary(t);
    const store = new ReleaseStore(home, { npm, registry: reg.url });
    const release = await store.prepare('0.1.1');
    const cli = await readFile(join(release.packageRoot, 'node_modules/esbuild/bin/esbuild'));
    assert.equal(sha256(cli), ESBUILD_POLICY.platforms[process.platform + '-' + process.arch]);
    await store.validate(release);
  },
);
