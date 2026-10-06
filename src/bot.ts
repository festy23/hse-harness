import { secret } from './config.js';

export interface BotUpdate {
  update_id: number;
  message?: {message_id:number;chat:{id:number;type:string};from?:{id:number};text?:string};
  callback_query?: {id:string;from:{id:number};message?:{chat:{id:number;type:string}};data?:string};
}
export type Buttons = {text:string;callback_data:string}[][];
export interface Notifier { send(text:string, buttons?:Buttons): Promise<void> }
export class TelegramBot implements Notifier {
  constructor(readonly owner: number) {}
  async call<T>(method:string, args:unknown): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${secret('TELEGRAM_BOT_TOKEN')}/${method}`, {
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(40_000),
    });
    const data = await response.json() as {ok:boolean;result:T;description?:string};
    if (!data.ok) throw new Error(`Telegram Bot API: ${data.description ?? response.status}`);
    return data.result;
  }
  async send(text:string, buttons?:Buttons): Promise<void> {
    // Никакого Markdown parse_mode: текст модели/источника не исполняется как разметка.
    const pieces = Array.from(text.matchAll(/[\s\S]{1,3500}/gu), x=>x[0]);
    for (let i=0;i<pieces.length;i++) await this.call('sendMessage', {
      chat_id:this.owner,text:pieces[i],link_preview_options:{is_disabled:true},
      ...(i === pieces.length-1 && buttons ? {reply_markup:{inline_keyboard:buttons}} : {}),
    });
  }
  updates(offset:number): Promise<BotUpdate[]> { return this.call('getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query']}); }
  ack(id:string): Promise<unknown> { return this.call('answerCallbackQuery',{callback_query_id:id}); }
  isOwner(u:BotUpdate): boolean {
    const m=u.message, q=u.callback_query;
    return Boolean(m && m.from?.id === this.owner && m.chat.id === this.owner && m.chat.type === 'private') ||
      Boolean(q && q.from.id === this.owner && q.message?.chat.id === this.owner && q.message.chat.type === 'private');
  }
}
