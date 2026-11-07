import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from 'imapflow';
import { runCompute } from './compute/index.js';
import { budgets, createOperation, OperationError, type OperationContext } from './operations.js';
import { HISTORY_FROM, hash, type Source } from './domain.js';
import { secret, type Config } from './config.js';
import type { Store } from './store.js';
import { guardImapClient, assertImapHealthy } from './imap-session.js';

export function textPart(
  node: MessageStructureObject | undefined,
): MessageStructureObject | undefined {
  const stack = node ? [node] : [];
  let html: MessageStructureObject | undefined,
    count = 0;
  while (stack.length) {
    const part = stack.pop()!;
    if (++count > 10_000) {
      throw new OperationError('payload-limit', 'Слишком сложная структура письма');
    }
    if (
      part.disposition?.toLowerCase() === 'attachment' ||
      part.dispositionParameters?.filename ||
      part.parameters?.name ||
      part.type === 'message/rfc822'
    ) {
      continue;
    }
    if (part.type === 'text/plain') {
      return part;
    }
    if (part.type === 'text/html') {
      html ??= part;
      continue;
    }
    for (let i = (part.childNodes?.length ?? 0) - 1; i >= 0; i--) {
      stack.push(part.childNodes![i]!);
    }
  }
  return html;
}
export class MailSource {
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly continuing: () => boolean = () => true,
  ) {}
  async poll(parent?: OperationContext): Promise<{ complete: boolean; initialComplete: boolean }> {
    const ctx = createOperation('source', budgets.mailSlice, parent);
    try {
      return await this.pollSlice(ctx);
    } catch (error) {
      if (ctx.signal.aborted) {
        if (
          !parent?.signal.aborted &&
          ctx.signal.reason instanceof OperationError &&
          ctx.signal.reason.kind === 'deadline'
        ) {
          return { complete: false, initialComplete: false };
        }
        throw ctx.signal.reason;
      }
      throw error;
    } finally {
      ctx.dispose();
    }
  }
  private async readText(
    client: ImapFlow,
    m: FetchMessageObject,
    message: OperationContext,
  ): Promise<string> {
    const part = textPart(m.bodyStructure);
    if (!part) {
      return '';
    }
    const maxBytes = Number(process.env.STUDY_MAX_TEXT_BYTES ?? 2_000_000);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 6000) {
      throw new Error('Некорректный STUDY_MAX_TEXT_BYTES');
    }
    const download = await client.download(String(m.uid), part.part || '1', {
      uid: true,
      maxBytes,
    });
    if (!download.content) {
      throw new Error('Текстовая часть письма не получена; не считать письмо обработанным');
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of download.content) {
      message.throwIfAborted();
      const value: unknown = chunk;
      if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
        throw new OperationError('protocol', 'Некорректный фрагмент письма');
      }
      const buffer = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        throw new OperationError('payload-limit', 'Письмо превышает допустимый размер');
      }
      chunks.push(buffer);
    }
    if (bytes >= maxBytes) {
      throw new Error(
        'Письмо превышает STUDY_MAX_TEXT_BYTES; не считать его полностью обработанным',
      );
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return part.type === 'text/html'
      ? (await runCompute({ type: 'html', mode: 'mail', html: text, maxBytes }, message)).text
      : text;
  }
  private async pollMessage(
    client: ImapFlow,
    m: FetchMessageObject,
    folder: string,
    validity: string,
    ctx: OperationContext,
  ): Promise<void> {
    const message = createOperation('request', budgets.message, ctx);
    const cancelMessage = () => client.close();
    message.signal.addEventListener('abort', cancelMessage, { once: true });
    try {
      message.throwIfAborted();
      if (!m.internalDate) {
        throw new Error('IMAP не вернул дату письма');
      }
      if (+new Date(m.internalDate) >= +new Date(HISTORY_FROM)) {
        const text = await this.readText(client, m, message);
        const envelope = m.envelope;
        const messageId = envelope?.messageId ?? `${folder}:${validity}:${m.uid}`;
        const source: Source = {
          id: `mail:${hash(messageId)}`,
          kind: 'mail',
          text: `Тема: ${envelope?.subject ?? ''}\n${text}`,
          date: new Date(m.internalDate).toISOString(),
          author: envelope?.from?.map((a) => a.address).join(', '),
          url: 'https://mail.yandex.ru/',
        };
        message.throwIfAborted();
        assertImapHealthy(client);
        await this.store.enqueue([source]);
      }
      message.throwIfAborted();
      assertImapHealthy(client);
      this.store.state.cursors[`mail:${folder}`] = `${validity}:${m.uid}`;
      await this.store.save();
    } catch (error) {
      if (message.signal.aborted) {
        throw message.signal.reason;
      }
      throw error;
    } finally {
      message.signal.removeEventListener('abort', cancelMessage);
      message.dispose();
    }
  }
  private async pollFolder(
    client: ImapFlow,
    folder: string,
    ctx: OperationContext,
  ): Promise<boolean> {
    const lock = await client.getMailboxLock(folder, {
      readOnly: true,
      acquireTimeout: Math.max(1, Math.min(30_000, Math.ceil(ctx.remainingMs()))),
    });
    try {
      if (!client.mailbox) {
        throw new Error('Папка не открыта');
      }
      const validity = client.mailbox.uidValidity.toString();
      const previous = this.store.state.cursors[`mail:${folder}`]?.split(':');
      const last = previous?.[0] === validity ? Number(previous[1]) : 0;
      const found = await client.search({ since: new Date('2026-08-31T00:00:00Z') }, { uid: true });
      const ids = (Array.isArray(found) ? found : [])
        .filter((uid) => uid > last)
        .sort((a, b) => a - b);
      for (let i = 0; i < ids.length; i += 25) {
        if (!this.continuing()) {
          return false;
        }
        ctx.throwIfAborted();
        const messages = await client.fetchAll(
          ids.slice(i, i + 25),
          { uid: true, envelope: true, internalDate: true, bodyStructure: true },
          { uid: true },
        );
        for (const message of messages) {
          if (!this.continuing()) {
            return false;
          }
          ctx.throwIfAborted();
          await this.pollMessage(client, message, folder, validity, ctx);
        }
      }
      return true;
    } finally {
      lock.release();
    }
  }
  private async pollSlice(
    ctx: OperationContext,
  ): Promise<{ complete: boolean; initialComplete: boolean }> {
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
    const cancel = () => client.close();
    ctx.signal.addEventListener('abort', cancel, { once: true });
    try {
      ctx.throwIfAborted();
      await client.connect();
      assertImapHealthy(client);
      const folders = this.config.folders.length
        ? this.config.folders
        : (await client.list())
            .filter((f) => !['\\Trash', '\\Junk', '\\Drafts'].includes(f.specialUse ?? ''))
            .map((f) => f.path);
      for (const folder of folders) {
        if (!this.continuing()) {
          return { complete: false, initialComplete: false };
        }
        ctx.throwIfAborted();
        if (!(await this.pollFolder(client, folder, ctx))) {
          return { complete: false, initialComplete: false };
        }
      }
      ctx.throwIfAborted();
      assertImapHealthy(client);
      return { complete: true, initialComplete: true };
    } finally {
      const cleanup = setTimeout(() => client.close(), budgets.cleanup);
      cleanup.unref();
      try {
        if (client.usable && !ctx.signal.aborted) {
          await client.logout();
        }
      } catch {
      } finally {
        clearTimeout(cleanup);
        client.close();
        ctx.signal.removeEventListener('abort', cancel);
      }
    }
  }
}
