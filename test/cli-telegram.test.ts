import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signInUser } from 'teleproto/client/auth.js';
import { bot, telegram, type TelegramSetupClient } from '../src/cli/connections/telegram.js';
import { SetupCancelled, SetupIssue } from '../src/cli/errors.js';
import type { SetupUI } from '../src/cli/ports.js';

function ui(): SetupUI {
  return {
    async input() { return 'fixture'; }, async choose() { return ''; }, async many() { return []; },
    async yes() { return true; }, note() {}, async task(_message, action) { return action(); },
  };
}
async function fixture(action: (path: string, client: TelegramSetupClient, screen: SetupUI, closed: () => number) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hse-cli-telegram-'));
  const path = join(root, 'telegram.session');
  const previous = { id: process.env.TELEGRAM_API_ID, hash: process.env.TELEGRAM_API_HASH };
  process.env.TELEGRAM_API_ID = '123'; process.env.TELEGRAM_API_HASH = 'synthetic-api-hash';
  let disconnects = 0;
  const client: TelegramSetupClient = {
    async start() {}, async getMe() { return { id: 42n }; }, async getDialogs() { return []; },
    session: { save() { return 'new-fixture-session'; } }, async disconnect() { disconnects++; },
  };
  try {
    await writeFile(path, 'old-fixture-session', { mode: 0o600 });
    await action(path, client, ui(), () => disconnects);
  } finally {
    if (previous.id === undefined) delete process.env.TELEGRAM_API_ID; else process.env.TELEGRAM_API_ID = previous.id;
    if (previous.hash === undefined) delete process.env.TELEGRAM_API_HASH; else process.env.TELEGRAM_API_HASH = previous.hash;
    await rm(root, { recursive: true, force: true });
  }
}

test('Telegram discovery deduplicates groups/channels, sorts labels and saves only after success', async () => {
  await fixture(async (path, client, screen, closed) => {
    let tasks = 0;
    screen.task = async (_message, action) => { tasks++; return action(); };
    client.getDialogs = async () => [
      { id: -1002n, title: 'Язык', isChannel: true }, { id: -1001n, title: 'Алгебра', isGroup: true },
      { id: -1002n, title: 'Duplicate', isChannel: true }, { id: 99n, title: 'Личный чат' },
    ];
    const result = await telegram(screen, 42, { sessionPath: path, createClient(session, id, hash) {
      assert.equal(session, 'old-fixture-session'); assert.equal(id, 123); assert.equal(hash, 'synthetic-api-hash'); return client;
    } });
    assert.deepEqual(result, { ownerId: 42, chats: [{ id: '-1001', label: 'Алгебра', hint: 'группа' }, { id: '-1002', label: 'Язык', hint: 'канал' }] });
    assert.equal(tasks, 1); assert.equal(closed(), 1);
    assert.equal(await readFile(path, 'utf8'), 'new-fixture-session'); assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test('Telegram refuses another owner before discovery and session overwrite', async () => {
  await fixture(async (path, client, screen, closed) => {
    client.getDialogs = async () => { assert.fail('Cannot discover chats for another owner'); };
    await assert.rejects(telegram(screen, 17, { sessionPath: path, createClient: () => client }), /другого владельца/);
    assert.equal(await readFile(path, 'utf8'), 'old-fixture-session'); assert.equal(closed(), 1);
  });
});

test('Telegram discovery failure closes the SDK and preserves previous session without leaking errors', async () => {
  await fixture(async (path, client, screen, closed) => {
    client.getDialogs = async () => { throw new Error('private token and synthetic-api-hash'); };
    await assert.rejects(telegram(screen, 42, { sessionPath: path, createClient: () => client }), error => {
      assert.ok(error instanceof SetupIssue); assert.doesNotMatch(error.message, /private|synthetic-api-hash/); return true;
    });
    assert.equal(await readFile(path, 'utf8'), 'old-fixture-session'); assert.equal(closed(), 1);
  });
});

test('real Teleproto signInUser preserves phone cancellation instead of prompting again, without network', async () => {
  await fixture(async (path, client, screen, closed) => {
    let prompts = 0;
    screen.input = async () => { prompts++; throw new SetupCancelled(); };
    client.start = async parameters => {
      // phoneNumber rejects before the real SDK can request a code or use a transport.
      await signInUser({} as Parameters<typeof signInUser>[0], { apiId: 123, apiHash: 'synthetic-api-hash' }, parameters);
    };
    await assert.rejects(telegram(screen, 42, { sessionPath: path, createClient: () => client }), SetupCancelled);
    assert.equal(prompts, 1); assert.equal(closed(), 1); assert.equal(await readFile(path, 'utf8'), 'old-fixture-session');
  });
});

for (const field of ['phoneCode', 'password'] as const) {
  test(`Telegram ${field} cancellation remains a cancellation through SDK error callback`, async () => {
    await fixture(async (path, client, screen, closed) => {
      let prompts = 0;
      screen.input = async request => { prompts++; assert.equal(request.secret, true); throw new SetupCancelled(); };
      client.start = async parameters => {
        try { await parameters[field]!(); } catch (error) { await parameters.onError(error as Error); }
      };
      await assert.rejects(telegram(screen, 42, { sessionPath: path, createClient: () => client }), SetupCancelled);
      assert.equal(prompts, 1); assert.equal(closed(), 1); assert.equal(await readFile(path, 'utf8'), 'old-fixture-session');
    });
  });
}

test('Telegram native AUTH_USER_CANCEL is normalized and auth failures stop the current step', async () => {
  await fixture(async (path, client, screen, closed) => {
    client.start = async () => { throw new Error('AUTH_USER_CANCEL'); };
    await assert.rejects(telegram(screen, 42, { sessionPath: path, createClient: () => client }), SetupCancelled);
    client.start = async parameters => { await parameters.onError(new Error('private-account-details')); };
    await assert.rejects(telegram(screen, 42, { sessionPath: path, createClient: () => client }), error => {
      assert.ok(error instanceof SetupIssue); assert.doesNotMatch(error.message, /private-account-details/); return true;
    });
    assert.equal(closed(), 2); assert.equal(await readFile(path, 'utf8'), 'old-fixture-session');
  });
});

test('Telegram bot validation returns username and sanitizes HTTP, malformed JSON and fetch errors', async () => {
  const screen = ui(), token = 'synthetic-bot-secret';
  const successful: typeof fetch = async (input, options) => {
    assert.equal(String(input), `https://api.telegram.org/bot${token}/getMe`); assert.equal(options?.redirect, 'error');
    return Response.json({ ok: true, result: { username: 'study_bot' } });
  };
  assert.equal(await bot(token, screen, successful), 'study_bot');
  const failures: (typeof fetch)[] = [
    async () => new Response(token, { status: 401 }), async () => new Response(`<html>${token}</html>`),
    async () => Response.json({ ok: true, result: { username: `${token}/invalid` } }),
    async () => { throw new Error(`Request failed https://api.telegram.org/bot${token}`); },
  ];
  for (const request of failures) await assert.rejects(bot(token, screen, request), error => {
    assert.ok(error instanceof SetupIssue); assert.ok(!error.message.includes(token)); return true;
  });
});
