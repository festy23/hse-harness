import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const required = process.env.HSE_REQUIRE_SYSTEMD === '1';
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function eventually(predicate, label, timeout = 25_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await delay(100); }
  throw new Error(`systemd fixture timeout: ${label}`);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function invoke(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 35_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  return result.stdout.trim();
}

test('real systemd stop and parent crash clean up the fixture cgroup before stable launcher restart', { timeout: 110_000 }, async t => {
  if (process.platform !== 'linux') {
    assert.equal(required, false, 'HSE_REQUIRE_SYSTEMD requires Linux/systemd');
    t.skip('Linux systemd integration only; macOS foreground tests run separately'); return;
  }
  const init = (await readFile('/proc/1/comm', 'utf8')).trim();
  if (init !== 'systemd') {
    assert.equal(required, false, 'HSE_REQUIRE_SYSTEMD requires systemd as PID 1');
    t.skip('No systemd PID 1; this test is mandatory in Linux CI'); return;
  }
  const account = userInfo(); assert.ok(account.uid > 0, 'Fixture runs under a non-root user');
  // Authentication is never interactive; CI must provide its normal passwordless sudo.
  invoke('sudo', ['-n', 'true']);
  // The production unit has PrivateTmp=true; a host /tmp fixture would be invisible.
  const home = await mkdtemp(join(account.homedir, '.hse-systemd-test-'));
  const id = randomUUID(); const unitName = `hse-harness-test-${id}.service`;
  assert.match(unitName, /^hse-harness-test-[a-f0-9-]+\.service$/);
  const unitPath = `/etc/systemd/system/${unitName}`;
  const control = args => invoke('sudo', ['-n', 'systemctl', ...args]);
  let installed = false;
  try {
    const runtime = join(home, 'runtime'); await mkdir(runtime, { mode: 0o700 });
    const engine = join(runtime, 'engine'); await mkdir(engine, { mode: 0o700 });
    for (const filename of await readdir(new URL('../runtime/', import.meta.url))) {
      if (filename.endsWith('.mjs')) await copyFile(new URL('../runtime/' + filename, import.meta.url), join(engine, filename));
    }
    const packageRoot = join(home, 'release-0.2.0'); await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await copyFile(new URL('./fixtures/update-worker.mjs', import.meta.url), join(packageRoot, 'dist', 'main.js'));
    await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}');
    // Deliberately keep the child alive on parent IPC loss: systemd must clean its cgroup.
    await writeFile(join(packageRoot, 'fixture.json'), JSON.stringify({ ignoreDisconnect: true }));
    const active = { version: '0.2.0', integrity: 'fixture-integrity', packageRoot, manifest: {
      protocolVersion: 1, stateSchemaVersion: 2, piVersion: '1.0.2', authFormat: 1, operationSemantics: 2, minSupervisorVersion: '1.0.0',
    } };
    const manifestPath = join(home, 'installed.json');
    await writeFile(manifestPath, JSON.stringify({ name: '@ivan-boss/hse-harness', version: active.version }));
    await writeFile(join(runtime, 'settings.json'), '{"enabled":false}', { mode: 0o600 });
    await writeFile(join(runtime, 'state.json'), JSON.stringify({ schemaVersion: 1, installation: { manifestPath }, active, previous: null, attempt: null, quarantine: [] }), { mode: 0o600 });
    const launcher = join(runtime, 'launcher.mjs');
    await writeFile(launcher, `import { Supervisor } from './engine/supervisor.mjs';
const home = ${JSON.stringify(home)};
const store = { async prepare() { throw new Error('Fixture does not install releases'); }, async validate() {}, async collect() {} };
await new Supervisor(home, { releaseStore: store, pollMs: 20, bootMs: 1000, finishMs: 2000, heartbeatMs: 3000, stdio: 'inherit' }).run();
`, { mode: 0o700 });
    const paths = Object.fromEntries(Object.entries({ DOTENV_CONFIG_PATH: '.env', STUDY_CONFIG: 'config.local.json', STUDY_DATA_DIR: 'data', STUDY_SECRETS_DIR: 'secrets' }).map(([key, value]) => [key, join(home, value)]));
    // Import the real unit renderer in a clean child; dotenv must not load the developer's .env.
    const env = { PATH: process.env.PATH, HOME: home, DOTENV_CONFIG_PATH: paths.DOTENV_CONFIG_PATH };
    const moduleURL = pathToFileURL(resolve('dist/cli/system-service.js')).href;
    const render = `const { serviceUnit } = await import(${JSON.stringify(moduleURL)}); console.log(serviceUnit(${JSON.stringify({ node: process.execPath, executable: launcher, home, uid: account.uid, gid: account.gid, paths })}));`;
    const unit = invoke(process.execPath, ['--input-type=module', '-e', render], { env }).replace('RestartSec=10', 'RestartSec=1');
    assert.ok(unit.includes(launcher)); assert.match(unit, /KillMode=control-group/);
    assert.doesNotMatch(unit, /hse-harness\.service|TELEGRAM|TOKEN|PASSWORD/);
    const sourceUnit = join(home, unitName); await writeFile(sourceUnit, unit);
    installed = true;
    invoke('sudo', ['-n', 'install', '-m', '644', sourceUnit, unitPath]);
    control(['daemon-reload']); control(['start', unitName]);
    const state = async () => JSON.parse(await readFile(join(runtime, 'state.json'), 'utf8'));
    const events = async () => (await readFile(join(home, 'fixture.events'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    await eventually(async () => (await state()).runningVersion === '0.2.0', 'initial worker activation');
    const first = await state(); const firstWorker = Number(await readFile(join(home, 'fixture.writer'), 'utf8'));
    assert.equal(Number(control(['show', unitName, '--property=MainPID', '--value'])), first.supervisorPid);
    // ExecStart's status rendering also contains changing timestamps/PID. Compare argv only.
    const startArguments = () => control(['show', unitName, '--property=ExecStart', '--value']).match(/argv\[\]=([^;]+)/)?.[1]?.trim();
    const execStart = startArguments(); assert.ok(execStart?.includes(launcher));
    control(['stop', unitName]);
    await eventually(() => !alive(first.supervisorPid) && !alive(firstWorker), 'normal stop child exit');
    control(['start', unitName]);
    await eventually(async () => (await state()).runningVersion === '0.2.0' && (await state()).supervisorPid !== first.supervisorPid, 'second start');
    const beforeCrash = await state(); const orphan = Number(await readFile(join(home, 'fixture.writer'), 'utf8'));
    assert.ok(alive(orphan));
    // Scope the destructive signal to this UUID unit's main process only.
    control(['kill', '--kill-whom=main', '--signal=SIGKILL', unitName]);
    await eventually(async () => {
      const current = await state();
      return current.runningVersion === '0.2.0' && current.supervisorPid !== beforeCrash.supervisorPid && !alive(orphan);
    }, 'cgroup cleanup and automatic supervisor restart');
    const currentWorker = Number(await readFile(join(home, 'fixture.writer'), 'utf8'));
    assert.notEqual(currentWorker, orphan); assert.ok(alive(currentWorker));
    const trace = await events(); assert.equal(trace.some(event => event.type === 'overlap'), false);
    assert.ok(trace.some(event => event.pid === orphan && event.type === 'stop' && event.cause === 'SIGTERM'), 'systemd must terminate the orphan child after SIGKILL of its supervisor');
    assert.ok(trace.filter(event => event.type === 'activate').length >= 3);
    assert.equal(startArguments(), execStart, 'restart uses unchanged home launcher');
    control(['stop', unitName]);
    await eventually(() => !alive(currentWorker), 'final child stop');
  } catch (error) {
    if (installed) {
      const logs = spawnSync('sudo', ['-n', 'journalctl', '-u', unitName, '--no-pager', '-n', '100'], { encoding: 'utf8', timeout: 10_000 });
      error.message += '\nFixture systemd log:\n' + (logs.stdout ?? '').slice(-16000);
    }
    throw error;
  } finally {
    if (installed) {
      // Only this test's UUID unit is touched, even when assertions fail.
      spawnSync('sudo', ['-n', 'systemctl', 'stop', unitName], { timeout: 15_000 });
      invoke('sudo', ['-n', 'rm', '-f', unitPath]);
      control(['daemon-reload']);
      spawnSync('sudo', ['-n', 'systemctl', 'reset-failed', unitName], { timeout: 10_000 });
    }
    await rm(home, { recursive: true, force: true });
  }
});
