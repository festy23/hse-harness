import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramBot, BotApiRejection } from '../src/bot.js';
import { Store } from '../src/store.js';

test('Telegram flood control survives restart and prevents early requests across methods', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hse-bot-api-'));
  const token = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = '1:fixture';
  t.after(async () => {
    if (token === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = token;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const store = new Store(dir);
  await store.load();
  await store.activateBot('telegram:1');
  let limited = true;
  const request = t.mock.method(globalThis, 'fetch', async () =>
    limited
      ? Response.json(
          {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 60 },
          },
          { status: 429 },
        )
      : Response.json({ ok: true, result: { message_id: 42 } }),
  );
  await assert.rejects(new TelegramBot(1, store).send('hello', undefined, 'one'), BotApiRejection);
  const recovered = new Store(dir);
  await recovered.load();
  const bot = new TelegramBot(1, recovered);
  await assert.rejects(bot.send('hello', undefined, 'one'), BotApiRejection);
  await assert.rejects(bot.updates(0), BotApiRejection);
  assert.equal(request.mock.callCount(), 1);
  assert.equal(recovered.state.outbox.one?.chunks[0]?.state, 'pending');
  assert.equal(recovered.state.outbox.one?.ambiguous, undefined);
  limited = false;
  const later = Date.now() + 61_000;
  t.mock.method(Date, 'now', () => later);
  await bot.send('hello', undefined, 'one');
  assert.equal(request.mock.callCount(), 2);
  assert.equal(recovered.state.outbox.one?.chunks[0]?.messageId, 42);
  await bot.send('hello', undefined, 'one');
  assert.equal(request.mock.callCount(), 2);
});

test('forwarded provenance survives restart and owner-update deduplication', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hse-bot-provenance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  await store.load();
  await store.enqueueOwner('сдал работу', 1, 'telegram:1', true);
  const recovered = new Store(dir);
  await recovered.load();
  await recovered.enqueueOwner('сдал работу', 1, 'telegram:1', false);
  assert.equal(recovered.state.queue.length, 1);
  assert.equal(recovered.state.queue[0]?.forwarded, true);
  await recovered.enqueueOwner('сдал сам', 2, 'telegram:1');
  assert.equal(recovered.state.queue[1]?.forwarded, undefined);
});

test('malformed Telegram success cannot be recorded as a delivered message', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hse-bot-response-'));
  const token = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = '1:fixture';
  t.after(async () => {
    if (token === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = token;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const store = new Store(dir);
  await store.load();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, result: {} }));
  await assert.rejects(new TelegramBot(1, store).send('hello', undefined, 'one'));
  assert.equal(store.state.outbox.one?.chunks[0]?.state, 'sending');
});

test('cooldown rejection cannot erase uncertainty about an earlier send', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hse-bot-uncertain-'));
  const token = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = '1:fixture';
  t.after(async () => {
    if (token === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = token;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const store = new Store(dir);
  await store.load();
  store.state.botRetryAt = Date.now() + 60_000;
  store.state.outbox.one = { text: 'hello', chunks: [{ state: 'sending' }], created: Date.now() };
  const messages: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, options: RequestInit) => {
    messages.push((JSON.parse(String(options.body)) as { text: string }).text);
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  const bot = new TelegramBot(1, store);
  await assert.rejects(bot.send('hello', undefined, 'one'), BotApiRejection);
  assert.equal(messages.length, 0);
  delete store.state.botRetryAt;
  await bot.send('hello', undefined, 'one');
  assert.match(messages[0]!, /^Повтор после сбоя:/);
});
