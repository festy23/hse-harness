import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

test('actual npm archive installs with runtime dependencies only, exposes CLI, stores a profile outside the package and runs compiled daemon', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hse npm package '));
  const project = resolve('.'); const prefix = join(root, 'prefix'); const home = join(root, 'home');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('STUDY_') && !key.startsWith('TELEGRAM_') && !key.startsWith('YANDEX_') && !key.startsWith('ICLOUD_') && !key.startsWith('GOOGLE_') && !key.startsWith('DOTENV_')));
  Object.assign(env, { HSE_HARNESS_HOME: home, NO_COLOR: '1' });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024, ...options });
    if (result.error) throw result.error;
    return { code: result.status, output: result.stdout + result.stderr, stdout: result.stdout };
  };
  try {
    const packed = run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', root, ...(process.env.HSE_PACKAGE_ARCHIVE ? [process.env.HSE_PACKAGE_ARCHIVE] : [])], { cwd: project });
    assert.equal(packed.code, 0, packed.output);
    const packedJSON = JSON.parse(packed.stdout);
    const [manifest] = Array.isArray(packedJSON) ? packedJSON : Object.values(packedJSON);
    const archive = join(root, manifest.filename);
    assert.equal(manifest.name, '@ivan-boss/hse-harness');
    assert.ok(manifest.files.some(file => file.path === 'bin/hse-harness.mjs'));
    assert.ok(!manifest.files.some(file => /^(data|secrets|src|test)\//.test(file.path) || file.path === '.env' || file.path === 'config.local.json'));
    const installed = run(npm, ['install', '--global', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', archive]);
    assert.equal(installed.code, 0, installed.output);
    const folder = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', '@ivan-boss/hse-harness');
    const executable = join(folder, 'bin/hse-harness.mjs');
    const cli = args => run(process.execPath, [executable, ...args]);
    const help = cli(['help']); assert.equal(help.code, 0, help.output); assert.match(help.output, /HSE HARNESS/);
    assert.equal(cli(['--version']).stdout.trim(), JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).version);
    const paths = JSON.parse(cli(['paths']).stdout); assert.equal(paths.home, home); assert.equal(paths.data, join(home, 'data'));
    assert.equal(cli(['unknown']).code, 1);
    const status = cli(['status']); assert.equal(status.code, 0, status.output); assert.match(status.output, /Сохранено 0\/5/);
    await assert.rejects(access(home), { code: 'ENOENT' });
    assert.equal(cli(['start']).code, 1);
    await assert.rejects(access(join(folder, 'node_modules', 'typescript')), { code: 'ENOENT' });
    if (process.platform !== 'win32') {
      assert.equal(run(join(prefix, 'bin', 'hse-harness'), ['help']).code, 0);
      const profile = run('python3', [join(project, 'test/cli/package_checks.py'), executable, root], { timeout: 30_000 });
      assert.equal(profile.code, 0, profile.output);
      const config = JSON.parse(await readFile(join(home, 'config.local.json'), 'utf8'));
      assert.equal(config.profile.name, 'Тестовый пользователь'); assert.equal(config.profile.course, 2);
    }
    if (process.platform === 'linux') {
      const preview = cli(['service', 'install', '--dry-run']); assert.equal(preview.code, 0, preview.output);
      const unit = join(root, 'hse-harness.service'); await writeFile(unit, preview.stdout);
      const verification = run('systemd-analyze', ['verify', unit]); assert.equal(verification.code, 0, verification.output);
    }
    // Use the installed package's SDK instances in the same real-daemon loopback e2e harness.
    const packagedPreload = join(folder, '.hse-e2e-preload.mjs');
    await writeFile(packagedPreload, await readFile(join(project, 'test/e2e/preload.mjs')));
    const e2e = run(process.execPath, [join(project, 'test/e2e/run.mjs'), '--calendar=icloud'], {
      cwd: project, env: { ...env, STUDY_E2E_ENTRY: join(folder, 'dist/main.js'), STUDY_E2E_PRELOAD: packagedPreload },
    });
    assert.equal(e2e.code, 0, e2e.output);
    await rm(packagedPreload);
    // The real compiled daemon boots without tsc/tsx and without contacting real accounts.
    await mkdir(home, { recursive: true });
    const configPath = join(home, 'config.local.json');
    let config; try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch { config = { chats: [] }; }
    await writeFile(configPath, JSON.stringify({ ...config, ownerId: 1 }));
    await writeFile(join(home, '.env'), "TELEGRAM_BOT_TOKEN='fixture-only'\n");
    const preload = join(root, 'offline.mjs');
    await writeFile(preload, "import timers from 'node:timers/promises';import {syncBuiltinESMExports} from 'node:module';const pause=timers.setTimeout;timers.setTimeout=(ms,v,o)=>pause(Math.min(ms,30),v,o);syncBuiltinESMExports();globalThis.fetch=async()=>{throw new Error('No external account calls in package test')};");
    const child = spawn(process.execPath, [executable, 'run'], { cwd: root, env: { ...env, NODE_OPTIONS: '--import ' + JSON.stringify(preload) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let ready;
    const started = new Promise(resolveStarted => { ready = resolveStarted; });
    const append = chunk => { output += chunk; if (output.includes('Календарь unavailable')) ready(); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    try {
      await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('Compiled daemon failed to boot: ' + output)), 10_000).unref())]);
      assert.doesNotMatch(output, /Собираю проект|tsc|tsx|MODULE_NOT_FOUND/);
      child.kill('SIGINT');
      const [code] = await Promise.race([once(child, 'exit'), new Promise((_, reject) => setTimeout(() => reject(new Error('Packaged daemon did not stop')), 10_000).unref())]);
      assert.equal(code, 0, output);
      await assert.rejects(access(join(home, 'data', 'service.lock')), { code: 'ENOENT' });
    } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } }
    await assert.rejects(access(join(folder, 'data')), { code: 'ENOENT' });
    await assert.rejects(access(join(folder, 'config.local.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
