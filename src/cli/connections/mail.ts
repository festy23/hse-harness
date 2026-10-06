import { secret } from '../../config.js';
import { SetupCancelled, SetupIssue } from '../errors.js';
import type { Choice, SetupUI } from '../ports.js';

interface MailFolder { path: string; specialUse?: string }
interface MailDiscovery {
  usable: boolean;
  connect(): Promise<unknown>;
  list(): Promise<MailFolder[]>;
  logout(): Promise<unknown>;
  close(): void;
}

/** Discovery never downloads messages; always close the connection, including failed auth. */
export async function mailFolderChoices(client: MailDiscovery, signal?: AbortSignal): Promise<Choice[]> {
  const cancel = () => client.close();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) throw new SetupCancelled();
    await client.connect();
    if (signal?.aborted) throw new SetupCancelled();
    const folders = await client.list();
    if (signal?.aborted) throw new SetupCancelled();
    return folders
      .filter(folder => !['\\Trash', '\\Junk', '\\Drafts'].includes(folder.specialUse ?? ''))
      .map(folder => ({ id: folder.path, label: folder.path }));
  } catch (error) {
    if (signal?.aborted) throw new SetupCancelled();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (client.usable) {
      await client.logout().catch(() => client.close());
    } else {
      client.close();
    }
  }
}

export async function connectMail(ui: SetupUI): Promise<Choice[]> {
  try {
    return await ui.task('Проверяю Яндекс Почту и получаю папки', async (signal?: AbortSignal) => {
      if (signal?.aborted) throw new SetupCancelled();
      const { ImapFlow } = await import('imapflow');
      if (signal?.aborted) throw new SetupCancelled();
      const client = new ImapFlow({
        host: 'imap.yandex.ru',
        port: 993,
        secure: true,
        logger: false,
        connectionTimeout: 20_000,
        socketTimeout: 30_000,
        auth: { user: secret('YANDEX_ADDRESS'), pass: secret('YANDEX_APP_PASSWORD') },
      });
      return mailFolderChoices(client, signal);
    });
  } catch (error) {
    if (error instanceof SetupCancelled) throw error;
    throw new SetupIssue('Яндекс Почта: вход не выполнен. Проверь адрес, пароль приложения «Почта», включённый IMAP и соединение.');
  }
}
