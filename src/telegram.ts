import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { getPeerId } from 'teleproto/Utils.js';
import bigInt from 'big-integer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HISTORY_FROM, type Source } from './domain.js';
import type { Store } from './store.js';
import { secret, secretsDir, type Config } from './config.js';

type Common = {pts:number;qts:number;date:number;seq:number};
export class TelegramSource {
  private client!:TelegramClient;
  private peers=new Map<string,Api.TypeInputPeer>();
  constructor(readonly config:Config,readonly store:Store,readonly onReply:(chat:string,id:string)=>Promise<void>,readonly alert:(text:string)=>Promise<void>) {}
  async connect():Promise<void> {
    const saved=await readFile(join(secretsDir(),'telegram.session'),'utf8');
    this.client=new TelegramClient(new StringSession(saved.trim()),Number(secret('TELEGRAM_API_ID')),secret('TELEGRAM_API_HASH'),{connectionRetries:3});
    await this.client.connect();
    if (!await this.client.checkAuthorization()) throw new Error('Telegram: повторите setup telegram');
    // Polling raw difference со своими устойчивыми counters; auth session их не сохраняет.
    this.client.updateManager.stop();
    const dialogs=await this.client.getDialogs({limit:undefined});
    for(const chat of this.config.chats) {
      const entity=dialogs.find(d=>d.id?.toString()===chat.id)?.entity;
      if (!entity) throw new Error(`Нет доступа к выбранному чату ${chat.id}`);
      this.peers.set(chat.id,await this.client.getInputEntity(entity));
    }
  }
  async poll():Promise<void> {
    if (!this.store.state.cursors.tgState) {
      const s=await this.client.invoke(new Api.updates.GetState());
      this.store.state.cursors.tgState=JSON.stringify({pts:s.pts,qts:s.qts,date:s.date,seq:s.seq});
      await this.store.save();
    }
    for(const [id,peer] of this.peers) {
      const key=`tgChannel:${id}`;
      if (peer instanceof Api.InputPeerChannel && !this.store.state.cursors[key]) {
        const full=await this.client.invoke(new Api.channels.GetFullChannel({channel:new Api.InputChannel({channelId:peer.channelId,accessHash:peer.accessHash})}));
        if (!(full.fullChat instanceof Api.ChannelFull) || !full.fullChat.pts) throw new Error(`Не получен pts чата ${id}`);
        this.store.state.cursors[key]=String(full.fullChat.pts);await this.store.save();
      }
      if (!this.store.state.cursors[`tgHistory:${id}`]) {
        await this.reconcile(id);
        this.store.state.cursors[`tgHistory:${id}`]='1';await this.store.save();
      }
    }
    await this.commonDifference();
    for(const [id,peer] of this.peers) if(peer instanceof Api.InputPeerChannel) await this.channelDifference(id,peer);
  }
  private source(chat:string,m:Api.Message):Source {
    const reply=m.replyTo instanceof Api.MessageReplyHeader ? m.replyTo.replyToMsgId : undefined;
    return {id:`tg:${chat}:${m.id}`,kind:'telegram',text:m.message,date:new Date(m.date*1000).toISOString(),
      author:m.fromId?getPeerId(m.fromId):undefined,replyTo:reply?`tg:${chat}:${reply}`:undefined,
      url:chat.startsWith('-100')?`https://t.me/c/${chat.slice(4)}/${m.id}`:undefined};
  }
  private async messages(items:Api.TypeMessage[]):Promise<void> {
    const texts:Source[]=[];
    for(const m of items) {
      if (!(m instanceof Api.Message)) continue;
      if(m.date < +new Date(HISTORY_FROM)/1000)continue;
      const id=getPeerId(m.peerId);
      if (!this.peers.has(id)) continue;
      const s=this.source(id,m);
      if (s.replyTo) await this.onReply(id,s.replyTo.split(':').at(-1)!);
      if (m.message.trim()) texts.push(s);
    }
    for(let i=0;i<texts.length;i+=20) await this.store.enqueue(texts.slice(i,i+20));
  }
  private async updates(items:Api.TypeUpdate[]):Promise<void> {
    for(const u of items) {
      if (u instanceof Api.UpdateNewMessage || u instanceof Api.UpdateNewChannelMessage || u instanceof Api.UpdateEditMessage || u instanceof Api.UpdateEditChannelMessage) await this.messages([u.message]);
      if (u instanceof Api.UpdateDeleteChannelMessages) await this.deleted(`-100${u.channelId}`,u.messages);
      if (u instanceof Api.UpdateDeleteMessages) {
        for(const id of this.peers.keys()) if (!id.startsWith('-100')) await this.deleted(id,u.messages);
      }
    }
  }
  private async deleted(chat:string,ids:number[]):Promise<void> {
    const sources=ids.filter(id=>this.store.state.seen[`tg:${chat}:${id}`]).map(id=>({
      id:`tg:${chat}:${id}`,kind:'telegram' as const,text:'Исходное сообщение удалено. Само удаление не подтверждает отмену задания.',date:HISTORY_FROM,deleted:true,
    }));
    await this.store.enqueue(sources);
  }
  private async reconcile(chat:string):Promise<void> {
    const found=new Set<number>();let batch:Api.TypeMessage[]=[];
    for await(const m of this.client.iterMessages(this.peers.get(chat)!,{limit:undefined})) {
      if(m.date < +new Date(HISTORY_FROM)/1000) break;
      found.add(m.id);batch.push(m);
      if(batch.length>=20) {await this.messages(batch);batch=[];}
    }
    await this.messages(batch);
    const old=Object.keys(this.store.state.seen).filter(k=>k.startsWith(`tg:${chat}:`)).map(k=>Number(k.split(':').at(-1)));
    await this.deleted(chat,old.filter(id=>!found.has(id)));
  }
  private async commonDifference():Promise<void> {
    for(let n=0;n<100;n++) {
      const s=JSON.parse(this.store.state.cursors.tgState!) as Common;
      const d=await this.client.invoke(new Api.updates.GetDifference({pts:s.pts,date:s.date,qts:s.qts}));
      if(d instanceof Api.updates.DifferenceTooLong) {
        await this.alert('Telegram: сервер не отдал весь пропущенный поток. Перепроверяю доступную историю; удаленные сведения могут быть недоступны.');
        const fresh=await this.client.invoke(new Api.updates.GetState());
        for(const id of this.peers.keys()) await this.reconcile(id);
        this.store.state.cursors.tgState=JSON.stringify(fresh);await this.store.save();return;
      }
      if(d instanceof Api.updates.DifferenceEmpty) {
        this.store.state.cursors.tgState=JSON.stringify({...s,date:d.date,seq:d.seq});await this.store.save();return;
      }
      await this.messages(d.newMessages);await this.updates(d.otherUpdates);
      const next=d instanceof Api.updates.DifferenceSlice ? d.intermediateState : d.state;
      this.store.state.cursors.tgState=JSON.stringify({pts:next.pts,qts:next.qts,date:next.date,seq:next.seq});await this.store.save();
      if(d instanceof Api.updates.Difference) return;
    }
    throw new Error('Telegram catch-up не завершен; продолжу следующим циклом');
  }
  private async channelDifference(id:string,peer:Api.InputPeerChannel):Promise<void> {
    for(let n=0;n<100;n++) {
      const d=await this.client.invoke(new Api.updates.GetChannelDifference({channel:new Api.InputChannel({channelId:peer.channelId,accessHash:peer.accessHash}),filter:new Api.ChannelMessagesFilterEmpty(),pts:Number(this.store.state.cursors[`tgChannel:${id}`]),limit:100,force:true}));
      let pts:number;
      if(d instanceof Api.updates.ChannelDifferenceTooLong) {
        await this.alert(`Чат ${id}: часть обновлений недоступна. Перепроверяю текущую историю.`);
        await this.reconcile(id);
        const dialog=d.dialog;
        if(!(dialog instanceof Api.Dialog) || !dialog.pts) throw new Error('Нет pts после ChannelDifferenceTooLong');
        pts=dialog.pts;
      } else {pts=d.pts;if(d instanceof Api.updates.ChannelDifference){await this.messages(d.newMessages);await this.updates(d.otherUpdates);}}
      this.store.state.cursors[`tgChannel:${id}`]=String(pts);await this.store.save();
      if(d.final) return;
    }
    throw new Error('Telegram channel catch-up не завершен');
  }
  async history(chat:string,limit=50):Promise<Source[]> {
    if (!this.peers.has(chat)) throw new Error('Чат не разрешен');
    const result:Source[]=[];
    for await(const m of this.client.iterMessages(this.peers.get(chat)!,{limit:Math.min(limit,100)})) if(m instanceof Api.Message && m.message) result.push(this.source(chat,m));
    return result;
  }
  async question(chat:string,text:string,randomId:string):Promise<string> {
    const peer=this.peers.get(chat);if(!peer) throw new Error('Чат не разрешен');
    const r=await this.client.invoke(new Api.messages.SendMessage({peer,message:text,randomId:bigInt(randomId)}));
    if(r instanceof Api.UpdateShortSentMessage) return String(r.id);
    if('updates' in r) for(const u of r.updates) {
      if(u instanceof Api.UpdateMessageID && u.randomId?.equals(bigInt(randomId))) return String(u.id);
      if((u instanceof Api.UpdateNewMessage || u instanceof Api.UpdateNewChannelMessage) && u.message instanceof Api.Message) return String(u.message.id);
    }
    throw new Error('Отправка не подтверждена id сообщения; повторю с тем же random_id');
  }
  async close():Promise<void> {await this.client?.disconnect();}
}
