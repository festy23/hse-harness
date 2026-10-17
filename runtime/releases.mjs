import { mkdir, readFile, writeFile, rename, rm, lstat, readdir, statfs, access, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { posix } from 'node:path';
import { atomicJSON, readJSON, privateDirectory, safePath, syncDirectory, syncTree } from './storage.mjs';
import { PACKAGE_NAME, assertManifest, stableVersion, sha256, inventoryTree, verifyInventory, ESBUILD_POLICY } from './manifest.mjs';

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DISK_RESERVE = 750 * 1024 * 1024;
const abortError = () => Object.assign(new Error('release preparation cancelled'), { name: 'AbortError' });
function cancelled(signal) { if (signal?.aborted) throw abortError(); }
function publicDescriptor(record) {
  // The journal stores identities and compatibility, not two entire copies of every
  // file hash per active/previous/attempt. The durable full inventory lives in release.json.
  const { inventory, ...manifest } = record.manifest;
  const { inventory: installedInventory, ...descriptor } = record;
  return { ...descriptor, manifest };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function processGroupAlive(pid) { try { process.kill(-pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; return true; } }
function signalGroup(child, signal) { if (!child.pid) return; try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } }

export async function runInstaller(command, args, { cwd, env, signal, timeout = 180000 } = {}) {
  cancelled(signal);
  if (!isAbsolute(command)) throw new Error('installer executable must be absolute');
  await access(command, constants.X_OK);
  cancelled(signal);
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let reason; let bytes = 0; let output = '';
  const stop = failure => {
    if (reason) return; reason = failure;
    signalGroup(child, 'SIGTERM');
  };
  const onAbort = () => stop(abortError());
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => stop(new Error('release installer timed out')), timeout);
  const consume = bytesChunk => {
    bytes += bytesChunk.length;
    if (bytes > 1024 * 1024) stop(new Error('installer exceeded output limit'));
    else output += bytesChunk.toString();
  };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  let killTimer;
  // Even if npm closes first, retain control of its process group until descendants exit.
  const armKill = setInterval(() => {
    if (reason && !killTimer) killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), 2000);
  }, 20);
  const outcome = await new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer); clearInterval(armKill); clearTimeout(killTimer);
  signal?.removeEventListener('abort', onAbort);
  if (child.pid && processGroupAlive(child.pid)) {
    signalGroup(child, 'SIGTERM'); await delay(100);
    if (processGroupAlive(child.pid)) { signalGroup(child, 'SIGKILL'); await delay(100); }
    if (processGroupAlive(child.pid)) {
      const error = new Error('installer descendants are not confirmed stopped; staging retained');
      error.retainStaging = true; throw error;
    }
  }
  if (reason) throw reason;
  if (outcome.error) throw new Error('cannot start release installer: ' + outcome.error.code);
  if (outcome.code !== 0) throw new Error('release installer failed (' + (outcome.code ?? outcome.signal) + ')');
  return output;
}


export async function inspectArchive(archive, { maximumUnpackedBytes = 500 * 1024 * 1024 } = {}) {
  const unzip = createGunzip(); const source = Readable.from([archive]); source.pipe(unzip);
  let header = Buffer.alloc(0); let skip = 0; let total = 0;
  try {
    for await (const chunk of unzip) {
      total += chunk.length;
      if (total > maximumUnpackedBytes) throw new Error('release archive exceeds unpacked size limit');
      let offset = 0;
      while (offset < chunk.length) {
        if (skip) { const amount = Math.min(skip, chunk.length - offset); skip -= amount; offset += amount; continue; }
        const need = Math.min(512 - header.length, chunk.length - offset);
        header = Buffer.concat([header, chunk.subarray(offset, offset + need)]); offset += need;
        if (header.length !== 512) continue;
        if (header.every(byte => byte === 0)) { header = Buffer.alloc(0); continue; }
        const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
        const prefix = field(345, 155); const name = (prefix ? prefix + '/' : '') + field(0, 100);
        const type = field(156, 1); const sizeField = field(124, 12).trim();
        if (!/^[0-7]+$/.test(sizeField)) throw new Error('unsupported archive size encoding');
        const size = Number.parseInt(sizeField, 8);
        if (!Number.isSafeInteger(size) || size > Math.min(maximumUnpackedBytes, 64 * 1024 * 1024)) throw new Error('archive member exceeds size limit');
        const clean = name.replace(/\/$/, '');
        if (!(clean === 'package' || clean.startsWith('package/')) || clean.split('/').some(part => part === '..' || part === '.') || clean.includes('\\')) throw new Error('archive member escapes package root');
        if (type === '1') throw new Error('archive hard links are not permitted');
        if (type === '2') {
          const target = field(157, 100); const resolved = posix.normalize(posix.join(posix.dirname(clean), target));
          if (posix.isAbsolute(target) || !(resolved === 'package' || resolved.startsWith('package/'))) throw new Error('archive symlink escapes package root');
        }
        // npm's ordinary tar archives use USTAR filenames. Reject extension headers
        // whose overridden paths would bypass the checks above rather than guessing.
        if (!['', '0', '2', '5'].includes(type)) throw new Error('unsupported archive extension');
        skip = Math.ceil(size / 512) * 512; header = Buffer.alloc(0);
      }
    }
    if (skip || header.length) throw new Error('truncated release archive');
  } finally { source.destroy(); unzip.destroy(); }
}

export class ReleaseStore {
  constructor(home, { registry = 'https://registry.npmjs.org/', npm, node = process.execPath, fetch: fetcher = globalThis.fetch, timeout = 180000, bootstrap = true } = {}) {
    if (!isAbsolute(home) || !isAbsolute(npm || '') || !isAbsolute(node)) throw new Error('release store requires absolute home/npm/Node paths');
    const registryURL = new URL(registry);
    // HTTP exists only as explicit loopback constructor injection for process integration tests.
    if (registryURL.protocol !== 'https:' && !(registryURL.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(registryURL.hostname))) throw new Error('unsafe release registry URL');
    if (registryURL.username || registryURL.password || registryURL.search || registryURL.hash) throw new Error('registry URL cannot contain credentials');
    this.home = resolve(home); this.runtime = join(this.home, 'runtime');
    this.releases = join(this.runtime, 'releases'); this.staging = join(this.runtime, 'staging');
    this.registry = registryURL.href.replace(/\/?$/, '/'); this.npm = npm; this.node = node;
    this.fetch = fetcher; this.timeout = timeout; this.bootstrap = bootstrap;
  }
  async initialize() {
    for (const directory of [this.home, this.runtime, this.releases, this.staging]) {
      await safePath(this.home, directory, { allowMissing: true }); await privateDirectory(directory);
    }
  }
  async diskAvailable() { const info = await statfs(this.runtime); return info.bavail * info.bsize; }
  async boundedFetch(url, signal, maximumBytes) {
    cancelled(signal);
    const timeoutSignal = AbortSignal.timeout(this.timeout);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetch(url, { signal: combined, redirect: 'error', headers: { accept: 'application/json, application/octet-stream' } });
    if (!response.ok) throw new Error('release registry HTTP ' + response.status);
    const length = Number(response.headers.get('content-length'));
    if (length > maximumBytes) throw new Error('release download exceeds size limit');
    const chunks = []; let count = 0;
    for await (const chunk of response.body) {
      cancelled(combined); count += chunk.length;
      if (count > maximumBytes) { await response.body.cancel?.().catch(() => {}); throw new Error('release download exceeds size limit'); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  installerEnvironment(stage) {
    return {
      PATH: [dirname(this.node), dirname(this.npm), '/usr/bin', '/bin'].join(':'),
      HOME: join(stage, 'npm-home'), TMPDIR: join(stage, 'tmp'),
      npm_config_cache: join(stage, 'npm-cache'), npm_config_userconfig: join(stage, 'empty-npmrc'),
      npm_config_globalconfig: join(stage, 'empty-global-npmrc'), npm_config_registry: this.registry,
      npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
      npm_config_fetch_retries: '0', npm_config_fetch_timeout: String(this.timeout),
      npm_config_update_notifier: 'false', npm_config_yes: 'true', CI: 'true',
    };
  }
  async prepare(version, { signal } = {}) {
    if (!stableVersion(version)) throw new Error('automatic releases require a stable exact version');
    await this.initialize(); cancelled(signal);
    const metadataBytes = await this.boundedFetch(new URL(encodeURIComponent(PACKAGE_NAME) + '/' + version, this.registry).href, signal, 1024 * 1024);
    const metadata = JSON.parse(metadataBytes);
    if (metadata.name !== PACKAGE_NAME || metadata.version !== version || metadata.engines?.node !== '>=22.19.0') throw new Error('release metadata identity or Node engine mismatch');
    const integrity = metadata.dist?.integrity;
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity || '') || Buffer.from(integrity.slice(7), 'base64').length !== 64 || Buffer.from(integrity.slice(7), 'base64').toString('base64') !== integrity.slice(7)) throw new Error('release requires a sha512 SRI');
    const tarballURL = new URL(metadata.dist.tarball);
    if (tarballURL.origin !== new URL(this.registry).origin || tarballURL.username || tarballURL.password) throw new Error('release archive must originate from the configured registry');
    const id = version + '-' + sha256(Buffer.from(integrity)).slice(0, 24);
    const releasePath = join(this.releases, id);
    await safePath(this.releases, releasePath, { allowMissing: true });
    const existing = await readJSON(join(releasePath, 'release.json'), null).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) {
      if (existing.integrity !== integrity || existing.version !== version) throw new Error('release identity collision');
      return this.validate({ version, integrity, releasePath });
    }
    if (await this.diskAvailable() < DISK_RESERVE) throw new Error('insufficient disk space for isolated release preparation');
    const stage = join(this.staging, randomUUID()); await privateDirectory(stage);
    let retained = false;
    try {
      const archive = await this.boundedFetch(tarballURL.href, signal, MAX_ARCHIVE_BYTES);
      const checksum = createHash('sha512').update(archive).digest();
      if (!timingSafeEqual(checksum, Buffer.from(integrity.slice(7), 'base64'))) throw new Error('release archive SRI mismatch');
      await inspectArchive(archive); cancelled(signal);
      const tgz = join(stage, 'release.tgz'); await writeFile(tgz, archive, { mode: 0o600, flag: 'wx' });
      const installation = join(stage, 'installation'); await privateDirectory(installation);
      for (const directory of ['npm-home', 'tmp', 'npm-cache']) await privateDirectory(join(stage, directory));
      await writeFile(join(stage, 'empty-npmrc'), '', { mode: 0o600 }); await writeFile(join(stage, 'empty-global-npmrc'), '', { mode: 0o600 });
      const env = this.installerEnvironment(stage);
      await runInstaller(this.npm, ['install', '--global', '--prefix', installation, tgz, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=' + this.registry], { cwd: stage, env, signal, timeout: this.timeout });
      cancelled(signal);
      const packageRoot = join(installation, 'lib/node_modules', PACKAGE_NAME);
      await safePath(stage, packageRoot);
      const pkg = await readJSON(join(packageRoot, 'package.json'));
      if (pkg.name !== PACKAGE_NAME || pkg.version !== version || pkg.engines?.node !== metadata.engines.node) throw new Error('installed package identity mismatch');
      const manifest = assertManifest(await readJSON(join(packageRoot, 'runtime-manifest.json')), version);
      // npm omits platform-specific bundled optional dependencies from other hosts.
      const supportedArchive = manifest.inventory.filter(entry => {
        const platformPackage = /^node_modules\/@esbuild\/([^/]+)\//.exec(entry.path);
        return !platformPackage || platformPackage[1] === process.platform + '-' + process.arch;
      });
      await verifyInventory(packageRoot, supportedArchive);
      for (const dependency of manifest.dependencies) {
        if (dependency.path.startsWith('node_modules/@esbuild/') && dependency.path !== 'node_modules/@esbuild/' + process.platform + '-' + process.arch) continue;
        const actual = await readJSON(join(packageRoot, dependency.path, 'package.json'));
        if (actual.name !== dependency.name || actual.version !== dependency.version) throw new Error('bundled dependency identity mismatch');
      }
      const esbuild = join(packageRoot, 'node_modules/esbuild');
      const script = await readFile(join(esbuild, 'install.js'));
      if (sha256(script) !== ESBUILD_POLICY.scriptSha256) throw new Error('esbuild bootstrap hash mismatch');
      const transform = `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(pathToFileURL(join(packageRoot, 'package.json')).href)}); const e=require('esbuild'); await e.transform('const x: number = 1',{loader:'ts'}); e.stop();`;
      let requiresBootstrap = sha256(await readFile(join(esbuild, 'bin/esbuild'))) !== ESBUILD_POLICY.platforms[process.platform + '-' + process.arch];
      try { await runInstaller(this.node, ['--input-type=module', '-e', transform], { cwd: stage, env, signal, timeout: this.timeout }); }
      catch (error) {
        if (error.name === 'AbortError' || error.retainStaging) throw error;
        requiresBootstrap = true;
      }
      // A matching optional package can make transform work while the archived CLI
      // still targets the publisher's platform. Verify and prepare both entrypoints.
      if (requiresBootstrap) {
        if (!this.bootstrap) throw new Error('audited esbuild platform preparation is disabled');
        await runInstaller(this.node, [join(esbuild, 'install.js')], { cwd: stage, env, signal, timeout: this.timeout });
      }
      // Bootstrap can modify only esbuild's platform-specific executable output.
      const afterBootstrap = supportedArchive.filter(entry => !/^node_modules\/esbuild\/(bin\/esbuild|lib\/downloaded-)/.test(entry.path));
      await verifyInventory(packageRoot, afterBootstrap);
      const binaryCandidates = [join(packageRoot, 'node_modules/@esbuild', process.platform + '-' + process.arch, 'bin/esbuild'), join(esbuild, 'lib/downloaded-@esbuild-' + process.platform + '-' + process.arch + '-esbuild')];
      let binaryHash;
      for (const file of binaryCandidates) {
        try { binaryHash = sha256(await readFile(file)); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (binaryHash !== ESBUILD_POLICY.platforms[process.platform + '-' + process.arch] || sha256(await readFile(join(esbuild, 'bin/esbuild'))) !== ESBUILD_POLICY.platforms[process.platform + '-' + process.arch]) throw new Error('esbuild platform binary hash mismatch');
      await runInstaller(this.node, ['--input-type=module', '-e', transform], { cwd: stage, env, signal, timeout: this.timeout });
      const sdk = pathToFileURL(join(packageRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
      await runInstaller(this.node, ['--input-type=module', '-e', `await import(${JSON.stringify(sdk)});`], { cwd: stage, env, signal, timeout: this.timeout });
      cancelled(signal);
      const descriptor = { format: 1, version, integrity, manifest, releasePath, packageRoot: join(releasePath, 'installation/lib/node_modules', PACKAGE_NAME), platform: process.platform + '-' + process.arch, inventory: await inventoryTree(installation), preparedAt: new Date().toISOString() };
      await syncTree(installation); cancelled(signal);
      await atomicJSON(join(stage, 'release.json'), descriptor);
      const complete = await open(join(stage, 'COMPLETE'), 'wx', 0o600);
      try { await complete.writeFile(sha256(Buffer.from(JSON.stringify(descriptor))) + '\n'); await complete.sync(); } finally { await complete.close(); }
      // npm scratch content is not part of the immutable release and contains no user credentials.
      for (const name of ['release.tgz', 'npm-home', 'tmp', 'npm-cache', 'empty-npmrc', 'empty-global-npmrc']) await rm(join(stage, name), { recursive: true, force: true });
      await syncDirectory(stage); cancelled(signal);
      await rename(stage, releasePath); await syncDirectory(this.releases);
      return publicDescriptor(descriptor);
    } catch (error) { retained = error.retainStaging === true; throw error; }
    finally { if (!retained) await rm(stage, { recursive: true, force: true }); }
  }
  async validate(release) {
    await this.initialize();
    if (!stableVersion(release?.version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(release.integrity || '') || Buffer.from(release.integrity.slice(7), 'base64').toString('base64') !== release.integrity.slice(7)) throw new Error('invalid release descriptor');
    const expected = join(this.releases, release.version + '-' + sha256(Buffer.from(release.integrity)).slice(0, 24));
    if (resolve(release.releasePath || '') !== expected) throw new Error('release path does not match identity');
    await safePath(this.releases, expected);
    const recorded = await readJSON(join(expected, 'release.json'));
    const completeInfo = await lstat(join(expected, 'COMPLETE'));
    if (!completeInfo.isFile() || completeInfo.isSymbolicLink()) throw new Error('release is incomplete');
    const complete = (await readFile(join(expected, 'COMPLETE'), 'utf8')).trim();
    if (complete !== sha256(Buffer.from(JSON.stringify(recorded)))) throw new Error('release descriptor checksum mismatch');
    if (recorded.format !== 1 || recorded.version !== release.version || recorded.integrity !== release.integrity || recorded.releasePath !== expected || recorded.packageRoot !== join(expected, 'installation/lib/node_modules', PACKAGE_NAME) || recorded.platform !== process.platform + '-' + process.arch) throw new Error('release descriptor identity mismatch');
    assertManifest(recorded.manifest, recorded.version);
    await safePath(expected, recorded.packageRoot);
    await verifyInventory(join(expected, 'installation'), recorded.inventory, { exact: true });
    return publicDescriptor(recorded);
  }
  async collect(protectedDescriptors = []) {
    await this.initialize();
    const protectedPaths = new Set(protectedDescriptors.filter(Boolean).map(entry => typeof entry === 'string' ? resolve(entry) : resolve(entry.releasePath)));
    const removed = []; const errors = [];
    for (const entry of await readdir(this.releases, { withFileTypes: true })) {
      const path = join(this.releases, entry.name);
      if (protectedPaths.has(path)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d+\.\d+\.\d+-[a-f0-9]{24}$/.test(entry.name)) { errors.push({ path, reason: 'unrecognized release entry retained' }); continue; }
      try { await safePath(this.releases, path); await rm(path, { recursive: true, force: true }); removed.push(path); }
      catch { errors.push({ path, reason: 'release cleanup failed' }); }
    }
    return { removed, errors };
  }
}
