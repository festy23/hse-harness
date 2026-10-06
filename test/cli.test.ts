import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';
import { SetupState, normalizeSetupConfig, upsertEnv } from '../src/cli/state.js';
import { Onboarding } from '../src/cli/onboarding.js';
import { SetupCancelled, SetupIssue } from '../src/cli/errors.js';
import { ServiceControl, runningPid } from '../src/cli/service.js';
import { setupReport, hasSubscription } from '../src/cli/status.js';
import { runCLI } from '../src/cli/application.js';
import type { SetupUI, SetupConnections } from '../src/cli/ports.js';

const project = resolve('.');
function fakeUI(overrides: Partial<SetupUI> = {}): SetupUI {
  return {
    async input() { throw new Error('Unexpected input'); },
    async choose() { throw new Error('Unexpected choice'); },
    async many() { return []; }, async yes() { return false; }, note() {},
    async task(_message, action) { return action(); }, ...overrides,
  };
}
async function temporary(action: (root: string, state: SetupState) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'hse-cli-'));
  try { const state = new SetupState(root, join(root, '.env'), join(root, 'config.json')); await state.load(); await action(root, state); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function child(args: string[], root: string, extra: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    const env = { ...process.env, DOTENV_CONFIG_PATH: join(root, 'empty.env'), STUDY_CONFIG: join(root, 'config.json'), STUDY_DATA_DIR: join(root, 'data'), STUDY_SECRETS_DIR: join(root, 'secrets'), ...extra };
    for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'YANDEX_ADDRESS', 'YANDEX_APP_PASSWORD', 'ICLOUD_USERNAME', 'ICLOUD_APP_PASSWORD', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) delete env[key];
    const processChild = spawn(process.execPath, ['--import', resolve(project, 'node_modules/tsx/dist/loader.mjs'), resolve(project, 'src/cli.ts'), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; processChild.stdout.on('data', data => { output += data; }); processChild.stderr.on('data', data => { output += data; });
    const timeout = setTimeout(() => { processChild.kill('SIGKILL'); reject(new Error('CLI child timeout')); }, 10_000);
    processChild.once('error', reject);
    processChild.once('exit', code => { clearTimeout(timeout); resolveResult({ code, output }); });
  });
}

test('CLI process help is side-effect free; unknown/noTTY/start failures return nonzero with actionable errors', async () => {
  await temporary(async (root) => {
    const help = await child(['help'], root); assert.equal(help.code, 0); assert.match(help.output, /HSE HARNESS/);
    await assert.rejects(() => stat(join(root, 'config.json')), { code: 'ENOENT' });
    await assert.rejects(() => stat(join(root, 'data')), { code: 'ENOENT' });
    const unknown = await child(['unknown'], root); assert.equal(unknown.code, 1); assert.match(unknown.output, /Неизвестная команда/);
    const piped = await child([], root); assert.equal(piped.code, 1); assert.match(piped.output, /интерактивный терминал/);
    const start = await child(['start'], root); assert.equal(start.code, 1); assert.match(start.output, /Запуск невозможен/);
  });
});

test('normalization supplies a missing role and rejects malformed, legacy, null and unsafe configuration explicitly', () => {
  const config = normalizeSetupConfig({ calendars: { timetable: { provider: 'icloud', id: 'schedule' } } });
  assert.ok(config.calendars.agent.id);
  for (const raw of [null, [], { chats: null }, { folders: [1] }, { ownerId: '1' }, { calendars: null }, { features: null }, { profile: {} }]) assert.throws(() => normalizeSetupConfig(raw), SetupIssue);
  assert.throws(() => normalizeSetupConfig({ timetableId: 'google-schedule', agentCalendarId: 'google-agent' }), /Устаревшие/);
});

test('empty/malformed auth and placeholder calendar IDs are not reported as ready; valid OAuth is saved rather than live-verified', async () => {
  await temporary(async (root, state) => {
    const secrets = join(root, 'secrets'); await mkdir(secrets);
    for (const text of ['{}', '{broken', JSON.stringify({ openai: { type: 'api_key', key: 'fixture' } })]) {
      await writeFile(join(secrets, 'pi-auth.json'), text);
      const report = await setupReport(state, undefined, {}, secrets);
      assert.equal(report.rows.find(row => row.id === 'model')!.ready, false);
      assert.match(report.rows.find(row => row.id === 'model')!.detail, /нужен вход/);
      assert.equal(report.rows.find(row => row.id === 'calendars')!.ready, false);
    }
    const auth = { openai: { type: 'oauth', access: 'private-access', refresh: 'private-refresh', expires: Date.now() - 1 } };
    assert.equal(hasSubscription(auth), true); state.config.model = 'fixture-model';
    await writeFile(join(secrets, 'pi-auth.json'), JSON.stringify(auth));
    const report = await setupReport(state, undefined, {}, secrets);
    assert.equal(report.rows.find(row => row.id === 'model')!.ready, true);
    assert.ok(!JSON.stringify(report).includes('private-access')); assert.ok(!JSON.stringify(report).includes('private-refresh'));
  });
});

test('a failed or cancelled section restores previous credentials, environment and config; a successful retry commits once', async () => {
  await temporary(async (root, state) => {
    const previous = process.env.TELEGRAM_BOT_TOKEN; process.env.TELEGRAM_BOT_TOKEN = 'old-token';
    try {
      await writeFile(state.envPath, "TELEGRAM_BOT_TOKEN='old-token'\nOTHER='keep'\n", { mode: 0o600 }); await state.save();
      const oldConfig = await readFile(state.configPath, 'utf8'); const oldEnv = await readFile(state.envPath, 'utf8');
      for (const error of [new SetupIssue('fixture failure'), new SetupCancelled()]) {
        const flow = new Onboarding(state, fakeUI({ async input() { return 'new-token'; } }), { async bot() { throw error; } } as unknown as SetupConnections);
        await assert.rejects(() => flow.run('telegram'), candidate => candidate === error);
        assert.equal(await readFile(state.envPath, 'utf8'), oldEnv); assert.equal(await readFile(state.configPath, 'utf8'), oldConfig); assert.equal(process.env.TELEGRAM_BOT_TOKEN, 'old-token');
      }
      await state.transaction(async () => { await state.env('TELEGRAM_BOT_TOKEN', 'verified-token'); state.config.model = 'verified-model'; await state.save(); });
      assert.equal(parse(await readFile(state.envPath, 'utf8')).TELEGRAM_BOT_TOKEN, 'verified-token'); assert.equal(state.config.model, 'verified-model');
      assert.equal((await stat(state.envPath)).mode & 0o777, 0o600);
    } finally { previous === undefined ? delete process.env.TELEGRAM_BOT_TOKEN : process.env.TELEGRAM_BOT_TOKEN = previous; }
  });
});

test('changing Google OAuth identity then cancelling restores the previous client and its tokens', async () => {
  await temporary(async (root, state) => {
    const previous = process.env.GOOGLE_CLIENT_ID; process.env.GOOGLE_CLIENT_ID = 'old-client';
    const secrets = join(root, 'secrets'); await mkdir(secrets); const tokenPath = join(secrets, 'google.json'); await writeFile(tokenPath, 'old-auth');
    try {
      await assert.rejects(() => state.transaction(async () => { await state.protectAuth('google.json'); await state.env('GOOGLE_CLIENT_ID', 'new-client'); await writeFile(tokenPath, 'new-auth'); throw new SetupCancelled(); }), SetupCancelled);
      assert.equal(await readFile(tokenPath, 'utf8'), 'old-auth'); assert.equal(process.env.GOOGLE_CLIENT_ID, 'old-client');
    } finally { previous === undefined ? delete process.env.GOOGLE_CLIENT_ID : process.env.GOOGLE_CLIENT_ID = previous; }
  });
});

test('a second setup writer cannot overwrite configuration changed by the first', async () => {
  await temporary(async (root, first) => {
    await first.save(); const second = new SetupState(root, first.envPath, first.configPath); await second.load();
    first.config.model = 'new-model'; await first.save();
    await assert.rejects(() => second.transaction(async () => { second.config.model = 'stale-model'; }), /другом окне/);
    assert.equal(JSON.parse(await readFile(first.configPath, 'utf8')).model, 'new-model');
  });
});

test('env encoding round-trips apostrophes and shell-like characters without expansion', () => {
  for (const value of ["it's a secret # $TOKEN", 'with `backticks` and apostrophe\'', 'quote "and" slash \\literal']) assert.equal(parse(upsertEnv('', 'TOKEN', value)).TOKEN, value);
});

test('service control does not build another instance, does not start after build failure and propagates daemon exit', async () => {
  await temporary(async (root, state) => {
    const before = process.env.TELEGRAM_BOT_TOKEN; process.env.TELEGRAM_BOT_TOKEN = 'fixture'; state.config.ownerId = 1;
    try {
      const calls: string[][] = [];
      const already = new ServiceControl(root, async (_command, args) => { calls.push(args); return 0; }, async () => 42);
      assert.deepEqual(await already.start(state.config, () => {}), { kind: 'already-running', pid: 42 }); assert.equal(calls.length, 0);
      const badBuild = new ServiceControl(root, async (_command, args) => { calls.push(args); return 2; }, async () => undefined);
      await assert.rejects(() => badBuild.start(state.config, () => {}), /Сборка/); assert.deepEqual(calls, [['run', 'build']]);
      let turn = 0; const daemon = new ServiceControl(root, async () => ++turn === 1 ? 0 : 7, async () => undefined);
      assert.deepEqual(await daemon.start(state.config, () => {}), { kind: 'stopped', code: 7 });
      const data = join(root, 'data'); await mkdir(data); await writeFile(join(data, 'service.lock'), String(process.pid)); assert.equal(await runningPid(data), process.pid);
    } finally { before === undefined ? delete process.env.TELEGRAM_BOT_TOKEN : process.env.TELEGRAM_BOT_TOKEN = before; }
  });
});

test('application cancellation returns to the same reusable menu and allows another action', async () => {
  await temporary(async (root, state) => {
    const actions = ['profile', 'status', 'exit']; const messages: string[] = [];
    const ui = fakeUI({ async choose() { return actions.shift()!; }, async input() { throw new SetupCancelled(); }, note(message) { messages.push(message); } });
    const view = { welcome() {}, showReport() {}, step() {}, success() {}, failure(message: string) { messages.push(message); }, finish() {} };
    const code = await runCLI([], { state, ui, connections: {} as SetupConnections, service: new ServiceControl(root, undefined, async () => undefined), view, interactive: true });
    assert.equal(code, 0); assert.equal(actions.length, 0); assert.ok(messages.some(message => message.includes('Раздел отменён')));
    await assert.rejects(() => readFile(state.configPath), { code: 'ENOENT' });
  });
});

test('cancelled Google account replacement with the same OAuth client restores auth and calendar roles', async () => {
  await temporary(async (root, state) => {
    const beforeId = process.env.GOOGLE_CLIENT_ID, beforeSecret = process.env.GOOGLE_CLIENT_SECRET;
    process.env.GOOGLE_CLIENT_ID = 'same-client'; process.env.GOOGLE_CLIENT_SECRET = 'same-secret';
    await mkdir(state.authDir, { recursive: true }); const authPath = join(state.authDir, 'google.json'); await writeFile(authPath, 'old-account');
    await state.calendars({ provider: 'google', id: 'old-schedule' }, { provider: 'google', id: 'old-agent' });
    const disk = await readFile(state.configPath, 'utf8'); const choices = ['google', 'google', 'schedule'];
    const ui = fakeUI({ async yes() { return true; }, async choose() { const choice = choices.shift(); if (!choice) throw new SetupCancelled(); return choice; } });
    const connections = { async calendars(_provider: string, _ui: SetupUI, reconnect: boolean) { assert.equal(reconnect, true); await writeFile(authPath, 'new-account'); return [{ id: 'schedule', label: 'Расписание', writable: true }, { id: 'agent', label: 'Дедлайны', writable: true }]; } } as unknown as SetupConnections;
    try {
      await assert.rejects(() => new Onboarding(state, ui, connections).run('calendars'), SetupCancelled);
      assert.equal(await readFile(authPath, 'utf8'), 'old-account'); assert.equal(await readFile(state.configPath, 'utf8'), disk);
    } finally {
      beforeId === undefined ? delete process.env.GOOGLE_CLIENT_ID : process.env.GOOGLE_CLIENT_ID = beforeId;
      beforeSecret === undefined ? delete process.env.GOOGLE_CLIENT_SECRET : process.env.GOOGLE_CLIENT_SECRET = beforeSecret;
    }
  });
});

test('cancelled subscription account replacement restores Pi auth and the old model', async () => {
  await temporary(async (_root, state) => {
    await mkdir(state.authDir, { recursive: true }); const authPath = join(state.authDir, 'pi-auth.json');
    await writeFile(authPath, 'old-subscription'); state.config.model = 'old-model'; await state.save();
    const ui = fakeUI({ async yes() { return true; }, async choose() { throw new SetupCancelled(); } });
    const connections = { async models() { await writeFile(authPath, 'new-subscription'); return [{ id: 'new-model', label: 'Новая модель' }]; } } as unknown as SetupConnections;
    await assert.rejects(() => new Onboarding(state, ui, connections).run('model'), SetupCancelled);
    assert.equal(await readFile(authPath, 'utf8'), 'old-subscription'); assert.equal(state.config.model, 'old-model');
  });
});

test('wizard return-to-menu also opens the menu from the direct configure command', async () => {
  await temporary(async (root, state) => {
    const actions = ['menu', 'exit']; const messages: string[] = [];
    const ui = fakeUI({ async choose(message) { messages.push(message); return actions.shift()!; } });
    const view = { welcome() {}, showReport() {}, step() {}, success() {}, failure() {}, finish() {} };
    assert.equal(await runCLI(['configure'], { state, ui, view, service: new ServiceControl(root, undefined, async () => undefined), interactive: true }), 0);
    assert.ok(messages.includes('Главное меню')); assert.equal(actions.length, 0);
  });
});

test('a new owner configured before profile is never offered the original student identity', async () => {
  await temporary(async (_root, state) => {
    state.config.ownerId = 99;
    const ui = fakeUI({ async input(request) { assert.equal(request.message, 'Как тебя зовут?'); assert.equal(request.initial, undefined); throw new SetupCancelled(); } });
    await assert.rejects(() => new Onboarding(state, ui, {} as SetupConnections).run('profile'), SetupCancelled);
    assert.equal(state.config.profile, undefined);
  });
});

test('cancelling a directly invoked wizard returns to the menu without committing its section', async () => {
  await temporary(async (root, state) => {
    const actions = ['edit', 'exit']; const notes: string[] = [];
    const ui = fakeUI({ async choose() { return actions.shift()!; }, async input() { throw new SetupCancelled(); }, note(message) { notes.push(message); } });
    const view = { welcome() {}, showReport() {}, step() {}, success() {}, failure() {}, finish() {} };
    assert.equal(await runCLI(['configure'], { state, ui, view, connections: {} as SetupConnections, service: new ServiceControl(root, undefined, async () => undefined), interactive: true }), 0);
    assert.equal(actions.length, 0); assert.ok(notes.some(message => message.includes('Раздел отменён')));
    await assert.rejects(() => readFile(state.configPath), { code: 'ENOENT' });
  });
});

test('Telegram reconfiguration preserves unavailable saved sources until explicitly unchecked', async () => {
  await temporary(async (_root, state) => {
    const names = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH'];
    const before = names.map(name => process.env[name]);
    for (const [index, name] of names.entries()) process.env[name] = ['fixture-token', '123', 'fixture-hash'][index];
    state.config.ownerId = 42;
    state.config.chats = [{ id: '-1002', title: 'Сохранённый канал' }];
    const notes: string[] = [];
    let keep = true;
    const ui = fakeUI({
      async yes() { return true; }, note(message) { notes.push(message); },
      async many(_message, choices, selected) {
        assert.ok(choices.some(choice => choice.id === '-1001'));
        assert.ok(choices.some(choice => choice.id === '-1002' && choice.hint?.includes('недоступен')));
        assert.deepEqual(selected, ['-1002']); return keep ? selected : [];
      },
    });
    const connections = { async bot() { return 'test_bot'; }, async telegram() { return { ownerId: 42, chats: [{ id: '-1001', label: 'Другой чат' }] }; } } as unknown as SetupConnections;
    try {
      const flow = new Onboarding(state, ui, connections);
      await flow.run('telegram');
      assert.deepEqual(state.config.chats, [{ id: '-1002', title: 'Сохранённый канал' }]);
      assert.ok(notes.some(message => message.includes('сейчас недоступны')));
      keep = false; await flow.run('telegram'); assert.deepEqual(state.config.chats, []);
    } finally { for (const [index, name] of names.entries()) { before[index] === undefined ? delete process.env[name] : process.env[name] = before[index]; } }
  });
});

test('cancelling chat selection after Telegram sign-in restores the previous session and API credentials', async () => {
  await temporary(async (_root, state) => {
    const names = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH'];
    const before = names.map(name => process.env[name]);
    for (const [index, name] of names.entries()) process.env[name] = ['old-token', '123', 'old-hash'][index];
    await mkdir(state.authDir, { recursive: true });
    const sessionPath = join(state.authDir, 'telegram.session'); await writeFile(sessionPath, 'old-session');
    state.config.ownerId = 42; state.config.chats = [{ id: '-1001', title: 'Старый чат' }]; await state.save();
    const disk = await readFile(state.configPath, 'utf8');
    const inputs = ['new-token', '456', 'new-hash'];
    const ui = fakeUI({ async input() { return inputs.shift()!; }, async many() { throw new SetupCancelled(); } });
    const connections = { async bot() { return 'test_bot'; }, async telegram() { await writeFile(sessionPath, 'new-session'); return { ownerId: 42, chats: [{ id: '-1002', label: 'Новый чат' }] }; } } as unknown as SetupConnections;
    try {
      await assert.rejects(() => new Onboarding(state, ui, connections).run('telegram'), SetupCancelled);
      assert.equal(await readFile(sessionPath, 'utf8'), 'old-session');
      assert.equal(await readFile(state.configPath, 'utf8'), disk);
      assert.equal(process.env.TELEGRAM_API_ID, '123'); assert.equal(process.env.TELEGRAM_API_HASH, 'old-hash');
      await assert.rejects(() => readFile(state.envPath), { code: 'ENOENT' });
    } finally { for (const [index, name] of names.entries()) { before[index] === undefined ? delete process.env[name] : process.env[name] = before[index]; } }
  });
});
