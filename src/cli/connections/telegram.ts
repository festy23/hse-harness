import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { Logger, LogLevel } from 'teleproto/extensions/Logger.js';
import type { UserAuthParams } from 'teleproto/client/auth.js';
import { secret, secretsDir } from '../../config.js';
import { writeSecret } from '../../store.js';
import { SetupCancelled, SetupIssue } from '../errors.js';
import type { Choice, SetupUI } from '../ports.js';

interface Dialog {
  id?: { toString(): string };
  title?: string;
  isGroup?: boolean;
  isChannel?: boolean;
}
export interface TelegramSetupClient {
  start(parameters: UserAuthParams): Promise<void>;
  getMe(): Promise<{ id: { toString(): string } }>;
  getDialogs(options: { limit: undefined }): Promise<Dialog[]>;
  session: { save(): unknown };
  disconnect(): Promise<void>;
}
export interface TelegramSetupDependencies {
  createClient?: (session: string, apiId: number, apiHash: string) => TelegramSetupClient;
  sessionPath?: string;
}

function fail(error: unknown, message: string): never {
  if (error instanceof SetupCancelled || (error instanceof Error && error.message === 'AUTH_USER_CANCEL')) {
    throw new SetupCancelled();
  }
  if (error instanceof SetupIssue) throw error;
  throw new SetupIssue(message);
}

/** Probe credentials without logging a request URL, which contains the bot token. */
export async function bot(token: string, ui: SetupUI, request: typeof fetch = fetch): Promise<string> {
  try {
    return await ui.task('Проверяю Telegram-бота', async (signal?: AbortSignal) => {
      if (signal?.aborted) throw new SetupCancelled();
      const response = await request(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]), redirect: 'error',
      }).catch(error => { if (signal?.aborted) throw new SetupCancelled(); throw error; });
      if (signal?.aborted) throw new SetupCancelled();
      if (!response.ok) throw new SetupIssue('Проверь токен бота и соединение с Telegram');
      const result: unknown = await response.json().catch(error => { if (signal?.aborted) throw new SetupCancelled(); throw error; });
      if (signal?.aborted) throw new SetupCancelled();
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('result' in result)) {
        throw new SetupIssue('Не удалось проверить Telegram-бота');
      }
      const account = result.result;
      if (!account || typeof account !== 'object' || !('username' in account) || typeof account.username !== 'string' || !/^[A-Za-z0-9_]+$/.test(account.username)) {
        throw new SetupIssue('Не удалось проверить Telegram-бота');
      }
      return account.username;
    });
  } catch (error) {
    fail(error, 'Не удалось подключиться к Telegram-боту. Проверь токен и соединение.');
  }
}

export async function telegram(ui: SetupUI, expectedOwnerId?: number, dependencies: TelegramSetupDependencies = {}): Promise<{ ownerId: number; chats: Choice[] }> {
  let client: TelegramSetupClient | undefined;
  let closing: Promise<void> | undefined;
  const disconnect = () => closing ??= client?.disconnect().catch(() => undefined) ?? Promise.resolve();
  try {
    const path = dependencies.sessionPath ?? join(secretsDir(), 'telegram.session');
    const existing = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const apiId = Number(secret('TELEGRAM_API_ID'));
    if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new SetupIssue('Telegram API ID должен быть положительным числом');
    const create = dependencies.createClient ?? ((session, id, hash) => {
      const connection = new TelegramClient(new StringSession(session), id, hash, {
        connectionRetries: 3, baseLogger: new Logger(LogLevel.NONE),
      });
      connection.setLogLevel(LogLevel.NONE);
      return connection;
    });
    client = create(existing.trim(), apiId, secret('TELEGRAM_API_HASH'));
    ui.note('Если Telegram-сессия уже сохранена, повторный код входа не потребуется.');
    // No progress animation here: the SDK can request interactive input during start().
    await client.start({
      phoneNumber: () => ui.input({ message: 'Номер Telegram с кодом страны' }),
      phoneCode: () => ui.input({ message: 'Код Telegram', secret: true }),
      password: () => ui.input({ message: 'Пароль Telegram 2FA', secret: true }),
      onError: error => fail(error, 'Вход в Telegram не завершён. Проверь введённые данные и повтори шаг.'),
    });
    const ownerId = Number((await client.getMe()).id.toString());
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new SetupIssue('Telegram вернул некорректный ownerId');
    if (expectedOwnerId && expectedOwnerId !== ownerId) {
      throw new SetupIssue('Для другого владельца используй отдельную установку с отдельными data и secrets');
    }
    const dialogs = await ui.task('Получаю группы и каналы Telegram', async (signal?: AbortSignal) => {
      if (signal?.aborted) throw new SetupCancelled();
      if (!signal) return client!.getDialogs({ limit: undefined });
      let interrupt!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        interrupt = () => { void disconnect().then(() => reject(new SetupCancelled())); };
      });
      signal.addEventListener('abort', interrupt, { once: true });
      try {
        const result = await Promise.race([client!.getDialogs({ limit: undefined }), cancelled]);
        if (signal.aborted) throw new SetupCancelled();
        return result;
      } catch (error) {
        if (signal.aborted) throw new SetupCancelled();
        throw error;
      } finally { signal.removeEventListener('abort', interrupt); }
    });
    const unique = new Map<string, Choice>();
    for (const dialog of dialogs) {
      if (!dialog.isGroup && !dialog.isChannel) continue;
      const id = dialog.id?.toString();
      if (!id || !/^-?\d+$/.test(id)) throw new SetupIssue('Telegram вернул некорректные данные чата');
      if (!unique.has(id)) unique.set(id, { id, label: dialog.title || 'Без названия', hint: dialog.isGroup ? 'группа' : 'канал' });
    }
    const chats = [...unique.values()].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    // Keep a working session untouched if identity validation, discovery or input fails.
    const session = client.session.save();
    if (typeof session !== 'string' || !session.trim()) throw new SetupIssue('Не удалось сохранить Telegram-сессию');
    await writeSecret(path, session);
    return { ownerId, chats };
  } catch (error) {
    return fail(error, 'Не удалось подключить Telegram. Проверь API ID, API hash и соединение.');
  } finally {
    await disconnect();
  }
}
