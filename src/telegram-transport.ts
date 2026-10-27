import { Api, type TelegramClient } from 'teleproto';
import { getInputPeer, getPeerId } from 'teleproto/Utils.js';
import bigInt from 'big-integer';
import { budgets, withOperation, OperationError, type OperationContext } from './operations.js';

const floodWaits = new WeakMap<TelegramClient, Map<string, number>>();
export async function telegramInvoke<R extends Api.AnyRequest>(
  client: TelegramClient,
  request: R,
  ctx?: OperationContext,
): Promise<R['__response']> {
  return withOperation('request', budgets.rpc, ctx, async (op) => {
    const until = floodWaits.get(client)?.get(request.className) ?? 0;
    if (until > performance.now()) {
      throw Object.assign(
        new OperationError('rate-limit', 'Telegram: временное ограничение запросов'),
        { retryAfterMs: Math.ceil(until - performance.now()) },
      );
    }
    try {
      return await client.invoke(request, undefined, {
        abortSignal: op.signal,
        timeout: Math.max(1, Math.ceil(op.remainingMs())),
        maxRetryCount: 2,
        floodSleepThreshold: 0,
      });
    } catch (error) {
      op.throwIfAborted();
      if (error instanceof OperationError) {
        throw error;
      }
      const code = (error as { code?: number }).code;
      if (code === 401) {
        throw new OperationError('authentication', 'Telegram: повторите подключение аккаунта');
      }
      if (code === 403) {
        throw new OperationError('permission', 'Telegram: нет доступа к чату');
      }
      const seconds = (error as { seconds?: unknown }).seconds;
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
        const retryAfterMs = Math.min(seconds, 86400) * 1000,
          waits = floodWaits.get(client) ?? new Map<string, number>();
        waits.set(request.className, performance.now() + retryAfterMs);
        floodWaits.set(client, waits);
        throw Object.assign(
          new OperationError('rate-limit', 'Telegram: временное ограничение запросов'),
          { retryAfterMs },
        );
      }
      throw error;
    }
  });
}
export interface TelegramDialog {
  id: string;
  title: string;
  isGroup: boolean;
  isChannel: boolean;
  entity: Api.TypeUser | Api.TypeChat;
}

export async function telegramDialogs(
  client: TelegramClient,
  ctx?: OperationContext,
): Promise<TelegramDialog[]> {
  return withOperation('connect', budgets.addChat, ctx, async (op) => {
    const out: TelegramDialog[] = [],
      seen = new Set<string>(),
      offsets = new Set<string>();
    let offsetId = 0,
      offsetDate = 0,
      offsetPeer: Api.TypeInputPeer = new Api.InputPeerEmpty(),
      excludePinned = false;
    while (true) {
      const result = await telegramInvoke(
        client,
        new Api.messages.GetDialogs({
          offsetId,
          offsetDate,
          offsetPeer,
          excludePinned,
          limit: 100,
          hash: bigInt.zero,
        }),
        op,
      );
      if (result instanceof Api.messages.DialogsNotModified) {
        throw new OperationError('protocol', 'Telegram не вернул список чатов');
      }
      const entities = new Map(
        [...result.users, ...result.chats]
          .filter((e) => !(e instanceof Api.UserEmpty || e instanceof Api.ChatEmpty))
          .map((e) => [getPeerId(e), e]),
      );
      for (const dialog of result.dialogs) {
        if (!(dialog instanceof Api.Dialog)) {
          continue;
        }
        const id = getPeerId(dialog.peer),
          entity = entities.get(id);
        if (!entity || seen.has(id)) {
          continue;
        }
        seen.add(id);
        const chat = entity instanceof Api.Chat || entity instanceof Api.Channel;
        out.push({
          id,
          title: chat ? entity.title : '',
          isGroup:
            entity instanceof Api.Chat ||
            (entity instanceof Api.Channel && Boolean(entity.megagroup)),
          isChannel: entity instanceof Api.Channel,
          entity,
        });
      }
      if (out.length > 20_000) {
        throw new OperationError('payload-limit', 'Слишком много Telegram-чатов');
      }
      if (result.dialogs.length < 100 || !(result instanceof Api.messages.DialogsSlice)) {
        return out;
      }
      const last = [...result.dialogs]
        .reverse()
        .find((d): d is Api.Dialog => d instanceof Api.Dialog);
      if (!last) {
        if (excludePinned) {
          return out;
        }
        excludePinned = true;
        continue;
      }
      const key = `${getPeerId(last.peer)}:${last.topMessage}`;
      if (offsets.has(key)) {
        throw new OperationError('protocol', 'Telegram повторил страницу чатов');
      }
      offsets.add(key);
      const entity = entities.get(getPeerId(last.peer));
      if (!entity) {
        throw new OperationError('protocol', 'Telegram вернул неполную страницу чатов');
      }
      const message = result.messages.find(
        (m) =>
          'peerId' in m &&
          m.peerId &&
          getPeerId(m.peerId) === getPeerId(last.peer) &&
          m.id === last.topMessage,
      );
      offsetId = last.topMessage;
      offsetDate = message && 'date' in message ? message.date : 0;
      offsetPeer = getInputPeer(entity);
      excludePinned = true;
    }
  });
}
export interface HistoryPage {
  messages: Api.TypeMessage[];
  nextOffset: number;
  complete: boolean;
}
export async function telegramHistoryPage(
  client: TelegramClient,
  peer: Api.TypeInputPeer,
  offsetId = 0,
  limit = 100,
  ctx?: OperationContext,
): Promise<HistoryPage> {
  const result = await telegramInvoke(
    client,
    new Api.messages.GetHistory({
      peer,
      offsetId,
      offsetDate: 0,
      addOffset: 0,
      limit: Math.min(100, Math.max(1, limit)),
      maxId: 0,
      minId: 0,
      hash: bigInt.zero,
    }),
    ctx,
  );
  if (result instanceof Api.messages.MessagesNotModified) {
    throw new OperationError('protocol', 'Telegram не вернул историю');
  }
  const ids = result.messages.map((m) => m.id).filter((id) => id > 0),
    nextOffset = ids.length ? Math.min(...ids) : offsetId;
  if (result.messages.length && offsetId && nextOffset >= offsetId) {
    throw new OperationError('protocol', 'Telegram повторил страницу истории');
  }
  return {
    messages: result.messages,
    nextOffset,
    complete: result.messages.length < Math.min(100, Math.max(1, limit)) || !ids.length,
  };
}
