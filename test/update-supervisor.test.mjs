import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Supervisor } from '../runtime/supervisor.mjs';
import { atomicJSON } from '../runtime/storage.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, timeout = 6000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) { const value = await predicate(); if (value) return value; await wait(10); }
  throw new Error('Timed out waiting for supervisor transition');
}
async function fixture(callback, configs = {}) {
  const home = await mkdtemp(join(tmpdir(), 'hse-supervisor-test-'));
  const releases = new Map(); const processes = [];
  const installedPath = join(home, 'installed.json');
  try {
    await mkdir(join(home, 'runtime'), { recursive: true });
    for (const version of ['0.2.0', '0.3.0', '0.4.0']) {
      const packageRoot = join(home, `release-${version}`);
      await mkdir(join(packageRoot, 'dist'), { recursive: true });
      await copyFile(new URL('./fixtures/update-worker.mjs', import.meta.url), join(packageRoot, 'dist', 'main.js'));
      await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}');
      await writeFile(join(packageRoot, 'fixture.json'), JSON.stringify(configs[version] ?? {}));
      releases.set(version, { version, packageRoot, integrity: 'sha512-' + version, manifest: {
        protocolVersion: 1, stateSchemaVersion: 2, piVersion: '1.0.2', authFormat: 1, operationSemantics: 2, minSupervisorVersion: '1.0.0',
      } });
    }
    const install = version => atomicJSON(installedPath, { name: '@ivan-boss/hse-harness', version });
    await install('0.2.0');
    await atomicJSON(join(home, 'runtime', 'settings.json'), { enabled: true });
    await atomicJSON(join(home, 'runtime', 'state.json'), { schemaVersion: 1, installation: { manifestPath: installedPath }, active: releases.get('0.2.0'), previous: null, attempt: null, quarantine: [] });
    const state = async () => JSON.parse(await readFile(join(home, 'runtime', 'state.json'), 'utf8'));
    const events = async () => (await readFile(join(home, 'fixture.events'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const store = { async prepare(version) { return releases.get(version); }, async validate(release) { assert.ok(releases.has(release.version)); }, async collect() {} };
    const launch = (overrides = {}) => {
      const supervisor = new Supervisor(home, { releaseStore: store, pollMs: 5, drainMs: 50, finishMs: 50, bootMs: 1000, probationMs: 60, heartbeatMs: 2000,
        debounce: 1, retryMs: [10, 10, 10], deferMs: 500, stdio: 'ignore', ...overrides });
      const run = supervisor.run(); run.catch(() => {}); processes.push({ supervisor, run });
      supervisor.testCompletion = run;
      return supervisor;
    };
    await callback({ home, installedPath, install, state, events, launch, releases, store });
  } finally {
    for (const { supervisor, run } of processes) { supervisor.requestStop(); await run.catch(() => {}); }
    await rm(home, { recursive: true, force: true });
  }
}

test('real IPC switch waits for old exit, commits one worker, and preserves current persistent data', async () => {
  await fixture(async ({ home, install, state, events, launch }) => {
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0');
    await eventually(async () => (await state()).active.version === '0.3.0' && !(await state()).attempt);
    const trace = await events();
    assert.equal(trace.some(event => event.type === 'overlap'), false);
    assert.ok(trace.findIndex(event => event.version === '0.2.0' && event.type === 'finished') < trace.findIndex(event => event.version === '0.3.0' && event.type === 'activate'));
    assert.equal(await readFile(join(home, 'fixture.data'), 'utf8'), '0.2.0\n0.3.0\n');
    assert.equal((await state()).previous.version, '0.2.0');
  });
});

test('busy worker resumes on drain timeout and receives no finish, abort or replacement', async () => {
  await fixture(async ({ install, state, events, launch }) => {
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).attempt?.phase === 'deferred');
    const trace = await events(); assert.ok(trace.some(event => event.type === 'resume'));
    assert.equal(trace.some(event => event.type === 'finish' || event.version === '0.3.0'), false);
    assert.equal((await state()).runningVersion, '0.2.0');
  }, { '0.2.0': { ignoreDrain: true } });
});

test('late quiescent ACK for a cancelled sequence cannot start a new worker', async () => {
  await fixture(async ({ install, state, events, launch }) => {
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).attempt?.phase === 'deferred');
    await wait(100);
    assert.equal((await state()).runningVersion, '0.2.0');
    assert.equal((await events()).some(event => event.type === 'finish' || event.version === '0.3.0'), false);
  }, { '0.2.0': { drainDelay: 100, lateQuiescent: true } });
});

test('unconfirmed old exit blocks replacement and leaves the old writer alone', async () => {
  await fixture(async ({ install, state, events, launch }) => {
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).deferredReason?.includes('Старый worker'));
    assert.equal((await events()).some(event => event.version === '0.3.0'), false);
    assert.equal((await state()).runningVersion, '0.2.0');
  }, { '0.2.0': { hangFinish: true } });
});

test('three real candidate crashes roll back with latest data and quarantine the failed identity', async () => {
  await fixture(async ({ home, install, state, events, launch }) => {
    launch({ probationMs: 1000 }); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).phase === 'rolled-back');
    const snapshot = await state(); assert.equal(snapshot.active.version, '0.2.0');
    assert.equal(snapshot.quarantine[0].version, '0.3.0');
    const trace = await events(); assert.equal(trace.filter(event => event.type === 'crash').length, 3); assert.equal(trace.some(event => event.type === 'overlap'), false);
    assert.equal(await readFile(join(home, 'fixture.data'), 'utf8'), '0.2.0\n0.3.0\n0.3.0\n0.3.0\n0.2.0\n');
  }, { '0.3.0': { crashOnActive: true } });
});

test('manual rollback hold survives supervisor restart while the newer npm version remains installed', async () => {
  await fixture(async ({ home, install, state, launch }) => {
    const first = launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).active.version === '0.3.0' && !(await state()).attempt);
    await atomicJSON(join(home, 'runtime', 'settings.json'), { enabled: true, request: { id: 'manual-test', action: 'rollback' } });
    await eventually(async () => (await state()).active.version === '0.2.0' && !(await state()).attempt);
    first.requestStop(); await first.testCompletion;
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0'); await wait(150);
    assert.equal((await state()).active.version, '0.2.0'); assert.equal((await state()).manualHold.version, '0.3.0');
  });
});

test('stop during a promotion does not activate a replacement in the background', async () => {
  await fixture(async ({ install, state, events, launch }) => {
    const supervisor = launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await events()).some(event => event.type === 'drain'));
    supervisor.requestStop(); await eventually(async () => !(await state()).runningVersion);
    assert.equal((await events()).some(event => event.version === '0.3.0'), false);
  }, { '0.2.0': { drainDelay: 35 } });
});

test('probation does not count stopped time and preserves cumulative crash budget on supervisor restart', async () => {
  await fixture(async ({ install, state, launch }) => {
    const first = launch({ probationMs: 400 }); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).attempt?.phase === 'probation');
    first.state.attempt.candidateFatalCount = 2; await first.save(); first.requestStop();
    await first.testCompletion; await wait(450);
    launch({ probationMs: 400 }); await eventually(async () => (await state()).runningVersion === '0.3.0');
    await wait(100); assert.equal((await state()).active.version, '0.2.0');
    assert.equal((await state()).attempt.candidateFatalCount, 2);
    await eventually(async () => (await state()).active.version === '0.3.0');
  });
});

test('torn installed manifest and release preparation failure leave the immutable worker running', async () => {
  await fixture(async ({ installedPath, install, state, events, launch, store }) => {
    const supervisor = launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await writeFile(installedPath, '{"name":'); await wait(70);
    assert.equal((await state()).runningVersion, '0.2.0');
    store.prepare = async () => { throw new Error('Fixture registry unavailable'); };
    await install('0.3.0'); await eventually(async () => (await state()).deferredReason === 'Fixture registry unavailable');
    assert.equal((await state()).runningVersion, '0.2.0');
    assert.equal((await events()).some(event => event.type === 'drain' || event.type === 'finish'), false);
    assert.equal(supervisor.worker.exited, false);
  });
});

test('disable received during preparation cancels promotion without stopping the current worker', async () => {
  await fixture(async ({ home, install, state, events, launch, releases, store }) => {
    let resume;
    const gate = new Promise(resolve => { resume = resolve; });
    store.prepare = async version => { await gate; return releases.get(version); };
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).phase === 'preparing');
    await atomicJSON(join(home, 'runtime', 'settings.json'), { enabled: false }); resume();
    await eventually(async () => (await state()).updatesEnabled === false);
    assert.equal((await state()).runningVersion, '0.2.0');
    assert.equal((await events()).some(event => event.type === 'drain'), false);
  });
});

test('npm source rollback before drain prevents activation of the already prepared candidate', async () => {
  await fixture(async ({ install, state, events, launch, releases, store }) => {
    let resume;
    const gate = new Promise(resolve => { resume = resolve; });
    store.prepare = async version => { await gate; return releases.get(version); };
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).phase === 'preparing');
    await install('0.2.0'); resume(); await eventually(async () => (await state()).installedVersion === '0.2.0');
    assert.equal((await state()).runningVersion, '0.2.0');
    assert.equal((await events()).some(event => event.type === 'drain' || event.version === '0.3.0'), false);
  });
});

test('a local candidate boot failure is quarantined and compatible previous is restored', async () => {
  await fixture(async ({ install, state, events, launch }) => {
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).phase === 'rolled-back');
    assert.equal((await state()).quarantine[0].reason, 'fixture local runtime failure');
    assert.equal((await events()).some(event => event.type === 'activate' && event.version === '0.3.0'), false);
    assert.equal((await events()).some(event => event.type === 'overlap'), false);
  }, { '0.3.0': { bootFail: true } });
});

test('disable after finish is accepted restores old release instead of leaving the bot stopped or applying candidate', async () => {
  await fixture(async ({ home, install, state, events, launch }) => {
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0');
    await eventually(async () => (await events()).some(event => event.type === 'finish' && event.version === '0.2.0'));
    await atomicJSON(join(home, 'runtime', 'settings.json'), { enabled: false });
    await eventually(async () => (await state()).updatesEnabled === false && !(await state()).attempt);
    assert.equal((await state()).runningVersion, '0.2.0');
    assert.equal((await events()).some(event => event.type === 'activate' && event.version === '0.3.0'), false);
    assert.deepEqual((await state()).quarantine, []);
  }, { '0.2.0': { finishDelay: 35 } });
});

test('disable during candidate local readiness prevents activation and restores the old release', async () => {
  await fixture(async ({ home, install, state, events, launch }) => {
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0');
    await eventually(async () => (await events()).some(event => event.type === 'prepare' && event.version === '0.3.0'));
    await atomicJSON(join(home, 'runtime', 'settings.json'), { enabled: false });
    await eventually(async () => (await state()).updatesEnabled === false && !(await state()).attempt);
    assert.equal((await state()).runningVersion, '0.2.0');
    assert.equal((await events()).some(event => event.type === 'activate' && event.version === '0.3.0'), false);
    assert.deepEqual((await state()).quarantine, []);
  }, { '0.3.0': { bootDelay: 35 } });
});

test('disable during probation returns the confirmed previous writer without discarding candidate changes', async () => {
  await fixture(async ({ home, install, state, launch }) => {
    launch({ probationMs: 250 }); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).attempt?.phase === 'probation');
    await atomicJSON(join(home, 'runtime', 'settings.json'), { enabled: false });
    await eventually(async () => (await state()).updatesEnabled === false && !(await state()).attempt);
    assert.equal((await state()).runningVersion, '0.2.0');
    assert.equal(await readFile(join(home, 'fixture.data'), 'utf8'), '0.2.0\n0.3.0\n0.2.0\n');
    assert.deepEqual((await state()).quarantine, []);
  });
});

test('busy rollback after disable resumes candidate then restores previous when its operation completes', async () => {
  await fixture(async ({ home, install, state, events, launch }) => {
    launch({ probationMs: 2000, deferMs: 20 }); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).attempt?.phase === 'probation');
    await atomicJSON(join(home, 'runtime', 'settings.json'), { enabled: false });
    await eventually(async () => (await events()).some(event => event.type === 'resume' && event.version === '0.3.0'));
    assert.equal((await state()).runningVersion, '0.3.0');
    await writeFile(join(home, '0.3.0.allow-drain'), 'ready');
    await eventually(async () => (await state()).runningVersion === '0.2.0' && !(await state()).attempt);
    assert.deepEqual((await state()).quarantine, []);
    assert.equal(await readFile(join(home, 'fixture.data'), 'utf8'), '0.2.0\n0.3.0\n0.2.0\n');
  }, { '0.3.0': { drainGate: true } });
});

test('a busy manual rollback is retried after deferred drain without another owner command', async () => {
  await fixture(async ({ home, install, state, events, launch }) => {
    launch({ deferMs: 20 }); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).active.version === '0.3.0' && !(await state()).attempt);
    await atomicJSON(join(home, 'runtime', 'settings.json'), { enabled: true, request: { id: 'deferred-manual', action: 'rollback' } });
    await eventually(async () => (await events()).some(event => event.type === 'resume' && event.version === '0.3.0'));
    await writeFile(join(home, '0.3.0.allow-drain'), 'ready');
    await eventually(async () => (await state()).active.version === '0.2.0' && !(await state()).attempt);
    assert.equal((await state()).manualHold.version, '0.3.0');
    assert.equal((await events()).some(event => event.type === 'overlap'), false);
  }, { '0.3.0': { drainGate: true } });
});

test('retry of a recovered live heartbeat clears persisted blocked state before a later reboot', async () => {
  await fixture(async ({ home, state, launch }) => {
    const first = launch({ heartbeatMs: 80 }); await eventually(async () => (await state()).phase === 'blocked');
    await writeFile(join(home, '0.2.0.allow-health'), 'ready');
    await atomicJSON(join(home, 'runtime', 'settings.json'), { enabled: true, request: { id: 'live-heartbeat-retry', action: 'retry' } });
    await eventually(async () => (await state()).lastRequestId === 'live-heartbeat-retry');
    assert.notEqual((await state()).phase, 'blocked');
    first.requestStop(); await first.testCompletion;
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    assert.equal(await readFile(join(home, 'fixture.data'), 'utf8'), '0.2.0\n0.2.0\n');
  }, { '0.2.0': { healthGate: true } });
});

test('recovery of a persisted user-cancel rollback keeps its no-quarantine policy', async () => {
  await fixture(async ({ home, install, state, launch }) => {
    const first = launch({ probationMs: 2000 }); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).attempt?.phase === 'probation');
    await atomicJSON(join(home, 'runtime', 'settings.json'), { enabled: false });
    let crashJournal;
    await eventually(async () => {
      const snapshot = await state();
      if (snapshot.attempt?.phase !== 'rolling-back') return false;
      crashJournal = snapshot; return true;
    });
    first.requestStop(); await first.testCompletion;
    // Journal-only crash injection; the fixture's latest data is never restored or removed.
    await atomicJSON(join(home, 'runtime', 'state.json'), crashJournal);
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0' && !(await state()).attempt);
    assert.deepEqual((await state()).quarantine, []);
    assert.ok((await readFile(join(home, 'fixture.data'), 'utf8')).includes('0.3.0\n'));
  }, { '0.2.0': { bootDelay: 100 } });
});

test('a deferred manual rollback survives supervisor reboot after its request was consumed', async () => {
  await fixture(async ({ home, install, state, launch }) => {
    const first = launch({ deferMs: 100 }); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).active.version === '0.3.0' && !(await state()).attempt);
    await atomicJSON(join(home, 'runtime', 'settings.json'), { enabled: true, request: { id: 'deferred-before-reboot', action: 'rollback' } });
    await eventually(async () => (await state()).attempt?.phase === 'deferred' && (await state()).attempt.manual);
    assert.equal((await state()).lastRequestId, 'deferred-before-reboot');
    first.requestStop(); await first.testCompletion;
    await writeFile(join(home, '0.3.0.allow-drain'), 'ready');
    launch({ deferMs: 100 });
    await eventually(async () => (await state()).active.version === '0.2.0' && !(await state()).attempt);
    assert.equal((await state()).manualHold.version, '0.3.0');
  }, { '0.3.0': { drainGate: true } });
});

test('stop received while validating a candidate prevents even its preparation process from spawning', async () => {
  await fixture(async ({ install, state, events, launch, store }) => {
    let validating = false, resume;
    const gate = new Promise(resolve => { resume = resolve; });
    store.validate = async release => { if (release.version === '0.3.0') { validating = true; await gate; } };
    const supervisor = launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(() => validating);
    supervisor.requestStop(); resume(); await supervisor.testCompletion;
    assert.equal((await events()).some(event => event.version === '0.3.0'), false);
  });
});

test('a real journal write failure stops the owned worker and lets its launcher exit nonzero', async () => {
  await fixture(async ({ home, events }) => {
    const launcher = join(home, 'failing-launcher.mjs');
    const supervisorURL = new URL('../runtime/supervisor.mjs', import.meta.url).href;
    await writeFile(launcher, `import { Supervisor } from ${JSON.stringify(supervisorURL)};
import { rename, mkdir } from 'node:fs/promises';
const home = ${JSON.stringify(home)};
const supervisor = new Supervisor(home, { releaseStore: { async validate() {}, async collect() {} }, pollMs: 10, bootMs: 1000, finishMs: 1000, heartbeatMs: 2000, stdio: 'ignore' });
let activeSaves = 0;
const save = supervisor.save.bind(supervisor);
supervisor.save = async () => {
  // Startup's two successful writes finish before the injected poll write.
  // This barrier avoids racing another atomic rename while corrupting the path.
  if (supervisor.worker?.mode === 'active' && ++activeSaves === 3) {
    await supervisor.saves;
    await rename(home + '/runtime/state.json', home + '/runtime/state.before-failure');
    await mkdir(home + '/runtime/state.json');
  }
  return save();
};
await supervisor.run().catch(error => { console.error('EXPECTED_JOURNAL_FAILURE', error.code); process.exitCode = 1; });
`);
    const child = spawn(process.execPath, [launcher], { env: { PATH: process.env.PATH, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const exit = once(child, 'exit'); let timeout;
    try {
      const [code] = await Promise.race([exit, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Failed supervisor left an unattended connected worker: ' + output)), 5000); })]);
      assert.equal(code, 1, output); assert.match(output, /EXPECTED_JOURNAL_FAILURE EISDIR/);
      const trace = await events();
      assert.equal(trace.filter(event => event.type === 'activate').length, 1);
      assert.ok(trace.some(event => event.type === 'stop' && event.cause === 'SIGTERM'));
      await assert.rejects(readFile(join(home, 'fixture.writer')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(home, 'runtime', 'supervisor.lock')), { code: 'ENOENT' });
      assert.equal(await readFile(join(home, 'fixture.data'), 'utf8'), '0.2.0\n');
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exit; }
    }
  });
});

test('worker crash recovers before a pending preparation completes; only the monitor promotes afterward', async () => {
  await fixture(async ({ install, state, events, launch, releases, store }) => {
    let releasePreparation; const gate = new Promise(resolve => { releasePreparation = resolve; }); let prepares = 0;
    store.prepare = async version => { prepares++; await gate; return releases.get(version); };
    const supervisor = launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(() => prepares === 1);
    supervisor.worker.child.kill('SIGTERM');
    await eventually(async () => (await events()).filter(e => e.version === '0.2.0' && e.type === 'activate').length === 2);
    assert.equal(supervisor.preparation.status, 'pending');
    assert.equal((await events()).some(e => e.version === '0.3.0'), false);
    releasePreparation();
    await eventually(async () => (await state()).active.version === '0.3.0');
    assert.equal(prepares, 1); assert.equal((await events()).some(e => e.type === 'overlap'), false);
  });
});

test('disabled preparation settles late without promotion or retry penalty while recovery continues', async () => {
  await fixture(async ({ home, install, state, events, launch, releases, store }) => {
    let releasePreparation, signal; const gate = new Promise(resolve => { releasePreparation = resolve; });
    store.prepare = async (version, options) => { signal = options.signal; await gate; return releases.get(version); };
    const supervisor = launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(() => Boolean(signal));
    await atomicJSON(join(home, 'runtime/settings.json'), { enabled: false });
    await eventually(() => signal.aborted);
    supervisor.worker.child.kill('SIGTERM');
    await eventually(async () => (await events()).filter(e => e.version === '0.2.0' && e.type === 'activate').length === 2);
    releasePreparation(); await eventually(() => supervisor.preparation === null);
    assert.equal(supervisor.retryCount, 0); assert.equal((await events()).some(e => e.version === '0.3.0'), false);
    assert.equal((await events()).some(e => e.type === 'overlap'), false);
  });
});

test('superseding installed version cancels cleanup before another preparation and ignores late success', async () => {
  await fixture(async ({ install, state, events, launch, releases, store }) => {
    let releasePreparation, signal; const gate = new Promise(resolve => { releasePreparation = resolve; }); const prepares = [];
    store.prepare = async (version, options) => { prepares.push(version); if (version === '0.3.0') { signal = options.signal; await gate; } return releases.get(version); };
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(() => Boolean(signal)); await install('0.4.0');
    await eventually(() => signal.aborted); await wait(40); assert.deepEqual(prepares, ['0.3.0']);
    releasePreparation(); await eventually(async () => (await state()).active.version === '0.4.0');
    assert.deepEqual(prepares, ['0.3.0', '0.4.0']);
    assert.equal((await events()).some(e => e.version === '0.3.0'), false);
    assert.equal((await events()).some(e => e.type === 'overlap'), false);
  });
});

test('manual rollback waits cancelled preparation cleanup and never promotes its late result', async () => {
  await fixture(async ({ home, install, state, events, launch, releases, store }) => {
    launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).active.version === '0.3.0' && !(await state()).attempt);
    let releasePreparation, signal; const gate = new Promise(resolve => { releasePreparation = resolve; });
    store.prepare = async (version, options) => { signal = options.signal; await gate; return releases.get(version); };
    await install('0.4.0'); await eventually(() => Boolean(signal));
    await atomicJSON(join(home, 'runtime/settings.json'), { enabled: true, request: { id: 'rollback-pending-preparation', action: 'rollback' } });
    await eventually(() => signal.aborted); await wait(40);
    assert.equal((await state()).lastRequestId, undefined);
    releasePreparation(); await eventually(async () => (await state()).active.version === '0.2.0' && !(await state()).attempt);
    assert.equal((await events()).some(e => e.version === '0.4.0'), false);
    assert.equal((await events()).some(e => e.type === 'overlap'), false);
  });
});

test('stop retains ownership until cancelled preparation cleanup settles and discards late rejection', async () => {
  await fixture(async ({ home, install, state, events, launch, store }) => {
    let releasePreparation, signal; const gate = new Promise(resolve => { releasePreparation = resolve; });
    store.prepare = async (_version, options) => { signal = options.signal; await gate; throw new Error('late aborted installer failure'); };
    const supervisor = launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(() => Boolean(signal));
    let stopped = false; supervisor.testCompletion.finally(() => { stopped = true; });
    supervisor.requestStop(); await eventually(() => supervisor.worker.exited); await wait(40);
    assert.equal(signal.aborted, true); assert.equal(stopped, false);
    assert.ok(JSON.parse(await readFile(join(home, 'runtime/supervisor.lock'), 'utf8')).ownerId);
    releasePreparation(); await supervisor.testCompletion;
    await assert.rejects(readFile(join(home, 'runtime/supervisor.lock')), { code: 'ENOENT' });
    assert.equal(supervisor.retryCount, 0); assert.equal((await events()).some(e => e.version === '0.3.0'), false);
  });
});

test('reboot with a descriptive preparing phase reconstructs work without a phantom pending task', async () => {
  await fixture(async ({ home, install, state, launch, store, releases }) => {
    const journal = await state(); journal.phase = 'preparing'; journal.pendingVersion = '0.3.0';
    await atomicJSON(join(home, 'runtime/state.json'), journal); await install('0.3.0');
    let prepares = 0; store.prepare = async version => { prepares++; return releases.get(version); };
    launch(); await eventually(async () => (await state()).active.version === '0.3.0');
    assert.equal(prepares, 1);
  });
});

test('retry cancels a pending preparation and waits its late rejection before a fresh attempt', async () => {
  await fixture(async ({ home, install, state, events, launch, releases, store }) => {
    let releasePreparation, signal; const gate = new Promise(resolve => { releasePreparation = resolve; }); let prepares = 0;
    store.prepare = async (version, options) => { prepares++; if (prepares === 1) { signal = options.signal; await gate; throw new Error('cancelled old attempt'); } return releases.get(version); };
    const supervisor = launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(() => Boolean(signal));
    await atomicJSON(join(home, 'runtime/settings.json'), { enabled: true, request: { id: 'retry-preparation', action: 'retry' } });
    await eventually(() => signal.aborted); await wait(40); assert.equal(prepares, 1);
    releasePreparation(); await eventually(async () => (await state()).active.version === '0.3.0');
    assert.equal(prepares, 2); assert.equal(supervisor.retryCount, 0);
    assert.equal((await state()).lastRequestId, 'retry-preparation');
    assert.equal((await events()).some(e => e.type === 'overlap'), false);
  });
});

test('failed background preparation records one backoff and keeps the owned worker active', async () => {
  await fixture(async ({ install, state, events, launch, store }) => {
    let prepares = 0; store.prepare = async () => { prepares++; throw new Error('preparation fixture failed'); };
    const supervisor = launch(); await eventually(async () => (await state()).runningVersion === '0.2.0');
    await install('0.3.0'); await eventually(async () => (await state()).deferredReason === 'preparation fixture failed');
    await wait(60); assert.equal(prepares, 1); assert.equal(supervisor.retryCount, 1);
    assert.equal((await state()).runningVersion, '0.2.0');
    assert.equal((await events()).some(e => e.type === 'drain' || e.version === '0.3.0'), false);
  });
});

test('notice acknowledgement save failure enters fatal shutdown and retains ownership until actual worker exit', async () => {
  await fixture(async ({ home, state, events, launch }) => {
    const logs=[];const supervisor=launch({finishMs:25,log:message=>logs.push(message)});
    await eventually(()=>supervisor.worker?.mode==='active');
    const worker=supervisor.worker,kill=worker.child.kill.bind(worker.child),signals=[];
    worker.child.kill=signal=>{signals.push(signal);return true;};
    const save=supervisor.save.bind(supervisor);let armed=true;
    supervisor.save=async()=>{
      if(armed&&!(supervisor.state.notices??[]).some(notice=>notice.id==='fatal-ack')){
        armed=false;throw new Error('Notice acknowledgement durable save failed');
      }
      await save();
    };
    // Insert the notice before any awaited work so the next acknowledgement is
    // the isolated failure, rather than a normal empty-journal poll save.
    supervisor.state.notices=[{id:'fatal-ack',text:'Fixture notice'}];
    let settled=false;supervisor.testCompletion.then(()=>{settled=true;},()=>{settled=true;});
    try{
      await save();supervisor.deliverNotices();
      await eventually(()=>logs.some(message=>message.includes('Fatal supervisor failure')));
      assert.equal(supervisor.stopping,true);assert.equal(worker.exited,false);assert.equal(settled,false);
      assert.deepEqual(signals,['SIGTERM']);
      assert.ok(JSON.parse(await readFile(join(home,'runtime/supervisor.lock'),'utf8')).ownerId);
      kill('SIGTERM');
      await assert.rejects(supervisor.testCompletion,/Notice acknowledgement durable save failed/);
      await assert.rejects(readFile(join(home,'runtime/supervisor.lock')),{code:'ENOENT'});
      assert.equal((await events()).some(event=>event.type==='stop'&&event.cause==='SIGTERM'),true);
      assert.equal((await state()).runningVersion,'0.2.0','failed supervisor never claims an unconfirmed clean exit in the journal');
    }finally{worker.child.kill=kill;if(!worker.exited)kill('SIGTERM');}
  });
});

test('synchronous child send failure rejects its command and requests graceful shutdown without throwing from IPC delivery', async () => {
  const signals=[];const supervisor=new Supervisor('/unused-send-fixture');
  supervisor.worker={id:'worker',attemptId:'attempt',exited:false,child:{connected:true,send(){throw Error('IPC channel race');},kill(signal){signals.push(signal);}}};
  await assert.rejects(supervisor.command('prepare','boot-ready',1000),/Worker IPC disconnected/);
  assert.equal(supervisor.waiters.size,0);assert.equal(supervisor.stopping,true);
  assert.match(supervisor.backgroundFailure.message,/Worker IPC disconnected/);assert.deepEqual(signals,['SIGTERM']);
});

test('asynchronous child send failure belongs to its captured worker and cannot stop a later incarnation', async () => {
  const supervisor=new Supervisor('/unused-send-fixture');let callback;const signals=[];
  const old={id:'old',attemptId:'attempt',exited:false,child:{connected:true,send(_message,done){callback=done;},kill(signal){signals.push(['old',signal]);}}};
  supervisor.worker=old;supervisor.send('notice',{id:'fixture',text:'Fixture'});
  supervisor.worker={id:'new',attemptId:'new-attempt',exited:false,child:{connected:true,kill(signal){signals.push(['new',signal]);}}};
  assert.doesNotThrow(()=>callback(Error('Late IPC failure')));
  assert.equal(supervisor.stopping,false);assert.equal(supervisor.backgroundFailure,null);assert.deepEqual(signals,[]);
});

test('asynchronous send failure promptly rejects matching waiters and stops the current worker gracefully', async () => {
  const supervisor=new Supervisor('/unused-send-fixture');let callback;const signals=[];
  supervisor.worker={id:'worker',attemptId:'attempt',exited:false,child:{connected:true,send(_message,done){callback=done;},kill(signal){signals.push(signal);}}};
  const command=supervisor.command('prepare','boot-ready',1000),rejected=assert.rejects(command,/Worker IPC disconnected/);
  assert.doesNotThrow(()=>callback(Error('IPC write failed')));await rejected;
  assert.equal(supervisor.waiters.size,0);assert.equal(supervisor.stopping,true);assert.deepEqual(signals,['SIGTERM']);
});
