import { budgets, createOperation } from '../../operations.js';
import { secret } from '../../config.js';
import { SetupCancelled, SetupIssue } from '../errors.js';
import type { Choice, SetupUI } from '../ports.js';
import { guardImapClient } from '../../imap-session.js';

interface MailFolder {
  path: string;
  specialUse?: string;
}
interface MailDiscovery {
  usable: boolean;
  connect(): Promise<unknown>;
  list(): Promise<MailFolder[]>;
  logout(): Promise<unknown>;
  close(): void;
}

export async function mailFolderChoices(
  client: MailDiscovery,
  signal?: AbortSignal,
): Promise<Choice[]> {
  const operation = createOperation('connect', budgets.mailSlice, signal),
    parent = signal;
  signal = operation.signal;
  const cancel = () => client.close();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (parent?.aborted) {
      throw new SetupCancelled();
    }
    operation.throwIfAborted();
    await client.connect();
    if (parent?.aborted) {
      throw new SetupCancelled();
    }
    operation.throwIfAborted();
    const folders = await client.list();
    if (parent?.aborted) {
      throw new SetupCancelled();
    }
    operation.throwIfAborted();
    return folders
      .filter((folder) => !['\\Trash', '\\Junk', '\\Drafts'].includes(folder.specialUse ?? ''))
      .map((folder) => ({ id: folder.path, label: folder.path }));
  } catch (error) {
    if (parent?.aborted) {
      throw new SetupCancelled();
    }
    operation.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    const cleanup = setTimeout(() => client.close(), budgets.cleanup);
    try {
      if (client.usable && !signal.aborted) {
        await client.logout();
      }
    } catch {
    } finally {
      clearTimeout(cleanup);
      client.close();
      operation.dispose();
    }
  }
}

export async function connectMail(ui: SetupUI): Promise<Choice[]> {
  try {
    return await ui.task('Проверяю Яндекс Почту и получаю папки', async (signal?: AbortSignal) => {
      if (signal?.aborted) {
        throw new SetupCancelled();
      }
      const { ImapFlow } = await import('imapflow');
      if (signal?.aborted) {
        throw new SetupCancelled();
      }
      const client = guardImapClient(
        new ImapFlow({
          host: 'imap.yandex.ru',
          port: 993,
          secure: true,
          logger: false,
          connectionTimeout: 20_000,
          socketTimeout: 30_000,
          auth: { user: secret('YANDEX_ADDRESS'), pass: secret('YANDEX_APP_PASSWORD') },
        }),
      );
      return mailFolderChoices(client, signal);
    });
  } catch (error) {
    if (error instanceof SetupCancelled) {
      throw error;
    }
    throw new SetupIssue(
      'Яндекс Почта: вход не выполнен. Проверь адрес, пароль приложения «Почта», включённый IMAP и соединение.',
    );
  }
}
