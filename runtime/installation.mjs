import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, writeFile, rename, chmod, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReleaseStore } from './releases.mjs';
import { acquireLock, atomicJSON, readJSON, privateDirectory, safePath, syncDirectory, syncTree } from './storage.mjs';
import { SUPERVISOR_VERSION } from './supervisor.mjs';
import { findNpm } from './executable.mjs';

async function livePID(path) {
  const record = await readJSON(path, null);
  if (record === null) return false;
  const pid = typeof record === 'number' ? record : record.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Повреждён lock; нужна ручная проверка');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export async function installRuntime(options) {
  const home = resolve(options.home), packageRoot = resolve(options.packageRoot);
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Управляемый запуск поддерживает macOS/Linux');
  const node = options.node ?? process.execPath;
  const metadata = await readJSON(join(packageRoot, 'package.json'));
  if (metadata.name !== '@ivan-boss/hse-harness') throw new Error('Неизвестный пакет');
  await privateDirectory(home);
  const root = join(home, 'runtime'); await privateDirectory(root);
  const unlock = await acquireLock(join(root, 'installation.lock'));
  try {
    if (await livePID(join(root, 'supervisor.lock')) ||
        await livePID(join(resolve(process.env.STUDY_DATA_DIR ?? join(home, 'data')), 'service.lock')))
      throw new Error('Бот уже работает. Для первого включения режима штатно останови прежний процесс');
    const old = await readJSON(join(root, 'state.json'), null);
    if (old && old.schemaVersion !== 1) throw new Error('Runtime journal несовместим; память не изменена');
    const store = options.releaseStore ?? new ReleaseStore(home, { node, npm: options.npm ?? await findNpm() });
    // A CLI restart must not bypass a manual hold, quarantine or interrupted
    // handoff by silently promoting the version installed in npm.
    const engineSource = await store.prepare(metadata.version);
    const active = old?.active ? await store.validate(old.active) : engineSource;
    const runtimeSource = join(engineSource.packageRoot, 'runtime');
    const modules = (await readdir(runtimeSource)).filter(name => name.endsWith('.mjs')).sort();
    if (!modules.includes('supervisor.mjs')) throw new Error('Выпуск не содержит supervisor');
    const bytes = await Promise.all(modules.map(async name => [name, await readFile(join(runtimeSource, name))]));
    const fingerprint = createHash('sha256');
    for (const [name, content] of bytes) fingerprint.update(name).update(content);
    const engineName = SUPERVISOR_VERSION + '-' + fingerprint.digest('hex').slice(0, 16);
    const engine = join(root, 'engines', engineName);
    await privateDirectory(join(root, 'engines')); await privateDirectory(engine);
    for (const [name, content] of bytes) {
      const target = join(engine, name); await safePath(engine, target, { allowMissing: true });
      try { if (!content.equals(await readFile(target))) throw new Error('Stable supervisor tree изменён'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(target, content, { flag: 'wx', mode: 0o600 }); }
    }
    await syncTree(engine); await syncDirectory(join(root, 'engines'));
    const settings = await readJSON(join(root, 'settings.json'), { enabled: true });
    await atomicJSON(join(root, 'settings.json'), settings);
    const state = { ...old, schemaVersion: 1, supervisorVersion: SUPERVISOR_VERSION, protocolVersion: 1,
      installation: { packageName: metadata.name, manifestPath: join(packageRoot, 'package.json'),
        registry: 'https://registry.npmjs.org/', node, npm: store.npm },
      active, previous: old?.previous ?? null,
      attempt: old?.attempt ?? null, quarantine: old?.quarantine ?? [], phase: old?.phase ?? 'installed', runningVersion: null,
      installedVersion: metadata.version, supervisorPid: null, updatesEnabled: settings.enabled !== false };
    await atomicJSON(join(root, 'state.json'), state);
    const launcher = join(root, 'launcher.mjs');
    const relativeEngine = './engines/' + engineName + '/supervisor.mjs';
    const content = `#!/usr/bin/env node\nimport { fileURLToPath } from 'node:url';\nimport { dirname } from 'node:path';\nimport { Supervisor } from ${JSON.stringify(relativeEngine)};\nconst home = dirname(dirname(fileURLToPath(import.meta.url)));\nprocess.env.HSE_HARNESS_HOME = home;\nconst supervisor = new Supervisor(home);\nawait supervisor.run().catch(error => { console.error(String(error.message).replace(/https?:\\/\\/\\S+/g, '[URL]')); process.exitCode = 1; });\n`;
    const temp = launcher + '.' + randomUUID();
    const handle = await open(temp, 'wx', 0o700);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await safePath(root, launcher, { allowMissing: true });
    await rename(temp, launcher); await chmod(launcher, 0o700); await syncDirectory(root);
    return { launcher, active };
  } finally { await unlock(); }
}

export async function startManaged(options) {
  const { launcher } = await installRuntime(options);
  return new Promise((resolveCode, reject) => {
    const child = spawn(options.node ?? process.execPath, [launcher], { env: process.env, stdio: 'inherit' });
    const stop = signal => { if (!child.killed) child.kill(signal); };
    const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolveCode(code ?? (signal === 'SIGINT' ? 130 : 143)); });
  });
}

export async function updateSettings(home, change) {
  if (typeof change.enabled !== 'boolean') throw new Error('enabled должен быть boolean');
  const root = join(resolve(home), 'runtime');
  const unlock = await acquireLock(join(root, 'settings.lock'));
  try {
    const settings = { ...await readJSON(join(root, 'settings.json'), { enabled: true }), enabled: change.enabled };
    if(!change.enabled)settings.automaticUpdates=false;
    delete settings.telegramUpdatePermission;
    await atomicJSON(join(root, 'settings.json'), settings); return settings;
  } finally { await unlock(); }
}

export async function requestUpdate(home, request) {
  if (!['retry', 'rollback'].includes(request.action)) throw new Error('Неизвестная команда updates');
  const root = join(resolve(home), 'runtime');
  const unlock = await acquireLock(join(root, 'settings.lock'));
  try {
    const settings = { ...await readJSON(join(root, 'settings.json'), { enabled: true }),
      request: { id: randomUUID(), action: request.action, createdAt: new Date().toISOString() } };
    await atomicJSON(join(root, 'settings.json'), settings); return settings;
  } finally { await unlock(); }
}

export async function readRuntimeStatus(home) {
  const root = join(resolve(home), 'runtime');
  const state = await readJSON(join(root, 'state.json'), null);
  const settings = await readJSON(join(root, 'settings.json'), { enabled: true });
  if (!state) return { updatesEnabled: settings.enabled !== false };
  let installedVersion;
  try { installedVersion = (await readJSON(state.installation.manifestPath)).version; } catch {}
  const lock = await readJSON(join(root, 'supervisor.lock'), null);
  const running = lock?.ownerId === state.supervisorOwnerId && await livePID(join(root, 'supervisor.lock'));
  return { installedVersion, runningVersion: running ? state.runningVersion ?? undefined : undefined,
    supervisorVersion: state.supervisorVersion, updatesEnabled: settings.enabled !== false,
    phase: state.attempt?.phase ?? state.phase, pendingVersion: state.attempt?.to?.version ?? state.pendingVersion,
    deferredReason: state.deferredReason, quarantine: state.quarantine?.map(q => ({ version: q.version, reason: q.reason })),
    manualHold: state.manualHold && { version: state.manualHold.version }, lastSuccessfulSwitch: state.lastSuccessfulSwitch };
}
