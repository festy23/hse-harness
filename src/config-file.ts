import { isRecord, parseRecord } from './validation.js';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processLock, writeSecret } from './store.js';
import type { TelegramChat } from './config.js';

export async function withConfigWriteLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const file = resolve(path),
    until = Date.now() + 5000;
  let release: (() => Promise<void>) | undefined;
  while (!release) {
    try {
      release = await processLock(dirname(file), basename(file) + '.lock');
    } catch (error) {
      const busy =
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        /Другой экземпляр|recovery interrupted or in progress|Неизвестный lock|Lock изменился|Не удалось получить writer lock/.test(
          (error as Error).message,
        );
      if (!busy || Date.now() >= until) {
        throw error;
      }
      await delay(25);
    }
  }
  try {
    return await action();
  } finally {
    await release();
  }
}

export async function saveTelegramChat(
  path: string,
  chat: TelegramChat,
  ownerId: number,
): Promise<TelegramChat> {
  return withConfigWriteLock(path, async () => {
    const raw = parseRecord(await readFile(path, 'utf8'));
    if (raw.ownerId !== ownerId) {
      throw new Error('Владелец настроек Telegram изменился; перезапусти агент');
    }
    if (
      !Array.isArray(raw.chats) ||
      raw.chats.some(
        (c: unknown) => !isRecord(c) || typeof c.id !== 'string' || typeof c.title !== 'string',
      )
    ) {
      throw new Error('Некорректный список Telegram-чатов в настройках');
    }
    const chats = raw.chats as TelegramChat[];
    const existing = chats.find((c) => c.id === chat.id);
    if (existing) {
      return existing;
    }
    chats.push(chat);
    await writeSecret(path, JSON.stringify(raw, null, 2) + '\n');
    return chat;
  });
}
