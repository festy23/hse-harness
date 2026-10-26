import { secret } from './config.js';
import { randomUUID, createHash } from 'node:crypto';
import type { Store } from './store.js';
import type { OperationContext } from './operations.js';

export interface BotUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number; type: string } };
    data?: string;
  };
}
export type Buttons = { text: string; callback_data: string }[][];
export class BotApiRejection extends Error {
  readonly source = 'provider' as const;
}

export function botIdentity(token: string): string {
  const numeric = /^(\d{1,20}):/.exec(token)?.[1];
  return numeric
    ? `telegram:${BigInt(numeric).toString()}`
    : `telegram:opaque:${createHash('sha256').update(token).digest('hex').slice(0, 24)}`;
}
export interface Notifier {
  send(text: string, buttons?: Buttons, deliveryId?: string, ctx?: OperationContext): Promise<void>;
}
export class TelegramBot implements Notifier {
  private readonly sends = new Map<string, Promise<void>>();
  constructor(
    readonly owner: number,
    readonly store?: Store,
  ) {}
  get identity(): string | undefined {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    return token ? botIdentity(token) : undefined;
  }
  async call<T>(method: string, args: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${secret('TELEGRAM_BOT_TOKEN')}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(40_000)])
          : AbortSignal.timeout(40_000),
      },
    );
    const data = (await response.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) {
      throw new BotApiRejection(`Telegram Bot API: ${data.description ?? response.status}`);
    }
    return data.result;
  }
  async send(
    text: string,
    buttons?: Buttons,
    deliveryId: string = randomUUID(),
    ctx?: OperationContext,
  ): Promise<void> {
    const existing = this.sends.get(deliveryId);
    if (existing) {
      return existing;
    }
    const result = this.sendChunks(text, buttons, deliveryId, ctx);
    this.sends.set(deliveryId, result);
    try {
      await result;
    } finally {
      this.sends.delete(deliveryId);
    }
  }
  private async sendChunks(
    text: string,
    buttons: Buttons | undefined,
    id: string,
    ctx?: OperationContext,
  ): Promise<void> {
    let delivery = this.store?.state.outbox[id];

    if (delivery) {
      text = delivery.text;
      buttons = delivery.buttons as Buttons | undefined;
    }
    const pieces = Array.from(text.matchAll(/[\s\S]{1,3500}/gu), (x) => x[0]);
    if (this.store && !delivery) {
      delivery = {
        text,
        buttons,
        chunks: pieces.map(() => ({ state: 'pending' as const })),
        created: Date.now(),
      };
      this.store.state.outbox[id] = delivery;
      await this.store.save();
    }
    for (let i = 0; i < pieces.length; i++) {
      ctx?.throwIfAborted();
      const receipt = delivery?.chunks[i];
      if (receipt?.state === 'sent') {
        continue;
      }
      const uncertain = receipt?.state === 'sending';
      if (receipt) {
        if (uncertain) {
          delivery!.ambiguous = true;
        }
        receipt.state = 'sending';
        await this.store!.save();
      }
      let result: { message_id?: number };
      try {
        result = await this.call<{ message_id?: number }>(
          'sendMessage',
          {
            chat_id: this.owner,
            text:
              (uncertain ? 'Повтор после сбоя: предыдущая доставка могла состояться.\n' : '') +
              pieces[i],
            link_preview_options: { is_disabled: true },
            ...(i === pieces.length - 1 && buttons
              ? { reply_markup: { inline_keyboard: buttons } }
              : {}),
          },
          ctx?.signal,
        );
      } catch (error) {
        if (receipt && error instanceof BotApiRejection) {
          receipt.state = 'pending';
          await this.store!.save();
        }
        if (ctx?.signal.aborted) {
          throw ctx.signal.reason;
        }
        throw error;
      }
      if (receipt) {
        receipt.state = 'sent';
        receipt.messageId = result?.message_id;
        await this.store!.save();
      }
    }
  }
  updates(offset: number, signal?: AbortSignal): Promise<BotUpdate[]> {
    return this.call(
      'getUpdates',
      { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
      signal,
    );
  }
  ack(id: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: id });
  }
  isOwner(u: BotUpdate): boolean {
    const m = u.message,
      q = u.callback_query;
    return (
      Boolean(
        m && m.from?.id === this.owner && m.chat.id === this.owner && m.chat.type === 'private',
      ) ||
      Boolean(
        q &&
        q.from.id === this.owner &&
        q.message?.chat.id === this.owner &&
        q.message.chat.type === 'private',
      )
    );
  }
}
