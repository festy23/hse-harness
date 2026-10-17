import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {createTelegramClient,telegramDeadline} from '../../telegram-client.js';
import {Api,type TelegramClient} from 'teleproto';
import {telegramDialogs,telegramInvoke} from '../../telegram-transport.js';
import {budgets,withOperation,OperationError} from '../../operations.js';
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
  destroy?():Promise<void>;
  invoke?:TelegramClient['invoke'];
}
export interface TelegramSetupDependencies {
  createClient?: (session: string, apiId: number, apiHash: string) => TelegramSetupClient;
  sessionPath?: string;
  networkBudgetMs?:number;
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
  const disconnect=()=>closing??=client?telegramDeadline(client.destroy?client.destroy():client.disconnect(),budgets.cleanup).catch(()=>{}):Promise.resolve();
  try {
    const path = dependencies.sessionPath ?? join(secretsDir(), 'telegram.session');
    const existing = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const apiId = Number(secret('TELEGRAM_API_ID'));
    if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new SetupIssue('Telegram API ID должен быть положительным числом');
    client = dependencies.createClient?.(existing.trim(), apiId, secret('TELEGRAM_API_HASH')) ?? await createTelegramClient(existing.trim());
    ui.note('Если Telegram-сессия уже сохранена, повторный код входа не потребуется.');
    // No progress animation here: the SDK can request interactive input during start().
    let remaining=dependencies.networkBudgetMs??budgets.connect,armedAt=0,timer:NodeJS.Timeout|undefined;
    let networkTimedOut=false;let expire!:(error:Error)=>void;
    const expired=new Promise<never>((_,reject)=>{expire=reject;});
    const pause=()=>{if(timer){clearTimeout(timer);remaining-=performance.now()-armedAt;timer=undefined;}};
    const arm=()=>{armedAt=performance.now();timer=setTimeout(()=>{networkTimedOut=true;void disconnect().finally(()=>expire(new OperationError('deadline','Вход Telegram не завершился вовремя','operation')));},Math.max(1,remaining));};
    const input=async(request:Parameters<SetupUI['input']>[0])=>{pause();try{return await ui.input(request);}finally{arm();}};
    arm();
    try{
      await Promise.race([client.start({
        phoneNumber:()=>input({message:'Номер Telegram с кодом страны'}),
        phoneCode:()=>input({message:'Код Telegram',secret:true}),
        password:()=>input({message:'Пароль Telegram 2FA',secret:true}),
        onError:error=>fail(error,'Вход в Telegram не завершён. Проверь введённые данные и повтори шаг.'),
      }),expired]);
      if(networkTimedOut){await disconnect();throw new OperationError('deadline','Вход Telegram не завершился вовремя','operation');}
    }finally{pause();}
    if(remaining<=0){await disconnect();throw new OperationError('deadline','Вход Telegram не завершился вовремя','operation');}
    const account=client.invoke?await withOperation('connect',budgets.rpc,undefined,async op=>{
      const users=await telegramInvoke(client as TelegramClient,new Api.users.GetUsers({id:[new Api.InputUserSelf()]}),op);
      if(!(users[0] instanceof Api.User))throw new SetupIssue('Telegram не вернул владельца');return users[0];
    }):await telegramDeadline(client.getMe(),budgets.rpc,()=>{void disconnect();});
    const ownerId=Number(account.id.toString());
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new SetupIssue('Telegram вернул некорректный ownerId');
    if (expectedOwnerId && expectedOwnerId !== ownerId) {
      throw new SetupIssue('Для другого владельца используй отдельную установку с отдельными data и secrets');
    }
    const dialogs = await ui.task('Получаю группы и каналы Telegram', async (signal?: AbortSignal) => {
      if (signal?.aborted) throw new SetupCancelled();
      if(client!.invoke)return withOperation('connect',budgets.addChat,signal,async op=>telegramDialogs(client as TelegramClient,op)).catch(error=>{if(signal?.aborted)throw new SetupCancelled();throw error;});
      if (!signal) return telegramDeadline(client!.getDialogs({ limit: undefined }),budgets.addChat,()=>{void disconnect();});
      let interrupt!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        interrupt = () => { void disconnect().then(() => reject(new SetupCancelled())); };
      });
      signal.addEventListener('abort', interrupt, { once: true });
      try {
        const result = await Promise.race([telegramDeadline(client!.getDialogs({ limit: undefined }),budgets.addChat,()=>{void disconnect();}), cancelled]);
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
