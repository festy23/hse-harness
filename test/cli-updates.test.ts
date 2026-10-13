import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRuntimeStatus, managedInstallation, updatesCLI } from '../src/cli/updates.js';
import { runningPid } from '../src/cli/service.js';
import { serviceUnit } from '../src/cli/system-service.js';

const globalRoot = '/tmp/a space/lib/node_modules/@ivan-boss/hse-harness';
test('managed starts require a permanent global npm layout; local/dev/npx never silently enable it', () => {
  assert.equal(managedInstallation(globalRoot, {}), true);
  for (const root of ['/tmp/repository', '/tmp/node_modules/@ivan-boss/hse-harness', '/tmp/.npm/_npx/1/lib/node_modules/@ivan-boss/hse-harness']) assert.equal(managedInstallation(root, {}), false);
  assert.equal(managedInstallation(globalRoot, { npm_command: 'exec' }), false);
});

test('update commands use owner runtime ports and report installed and running versions separately', async () => {
  const calls: unknown[] = []; const output: string[] = [];
  const api = {
    async installRuntime() { throw new Error('Control commands must not install/start a bot'); },
    async readRuntimeStatus() { return { installedVersion: 'stale-observer', runningVersion: '0.1.0', supervisorVersion: '1', updatesEnabled: true, phase: 'deferred', pendingVersion: '0.2.0', deferredReason: 'Нет сети' }; },
    async updateSettings(home: string, change: { enabled: boolean }) { calls.push({ home, change }); },
    async requestUpdate(home: string, request: { action: 'retry' | 'rollback' }) { calls.push({ home, request }); },
  };
  const options = { home: '/tmp/owner', packageRoot: globalRoot, api, env: {}, platform: 'linux' as const, print: (message: string) => output.push(message) };
  assert.equal(await updatesCLI(['status'], options), 0);
  assert.match(output[0]!, /Установлена через npm: \d/); assert.match(output[0]!, /Работающая версия: 0\.1\.0/);
  assert.match(output[0]!, /Нет сети/); assert.equal(calls.length, 0);
  for (const action of ['enable', 'disable', 'retry', 'rollback']) assert.equal(await updatesCLI([action], options), 0);
  assert.deepEqual(calls, [
    { home: '/tmp/owner', change: { enabled: true } }, { home: '/tmp/owner', change: { enabled: false } },
    { home: '/tmp/owner', request: { action: 'retry' } }, { home: '/tmp/owner', request: { action: 'rollback' } },
  ]);
  await assert.rejects(updatesCLI(['retry'], { ...options, packageRoot: '/repo' }), /постоянной npm/);
  await assert.rejects(updatesCLI(['enable'], { ...options, platform: 'win32' }), /macOS\/Linux/);
  await assert.rejects(updatesCLI(['status', '--extra'], options), /Использование/);
});

test('readonly update status does not create the personal runtime directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hse-update-cli-'));
  try {
    await updatesCLI(['status'], { home: join(dir, 'missing'), print() {} });
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runtime status is an allowlisted summary and does not dump arbitrary journal secrets', () => {
  const status = { phase: 'blocked', updatesEnabled: false, quarantine: { token: 'never-print' }, secret: 'never-print' };
  assert.doesNotMatch(formatRuntimeStatus(status), /never-print|token|secret/);
});

test('process status understands both legacy and owner-identified worker locks without signalling them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hse-lock-cli-'));
  try {
    for (const lock of [String(process.pid), JSON.stringify({ pid: process.pid, nonce: 'fixture', startedAt: Date.now() })]) {
      await writeFile(join(dir, 'service.lock'), lock); assert.equal(await runningPid(dir), process.pid);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('systemd refuses arbitrary environment entries and preserves direct worker isolation', () => {
  assert.throws(() => serviceUnit({ node: '/node', executable: '/home/study/runtime/launcher.mjs', home: '/home/study', uid: 1000, gid: 1000, paths: { TELEGRAM_BOT_TOKEN: 'hidden' } }), /только пути/);
});
