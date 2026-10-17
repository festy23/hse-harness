import { TelegramClient, Api } from 'teleproto';
import { getInputPeer,getPeerId } from 'teleproto/Utils.js';
import bigInt from 'big-integer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HISTORY_FROM,hash, type Source } from './domain.js';
import type { Store } from './store.js';
import { secretsDir, type Config } from './config.js';
import {createTelegramClient,telegramDeadline} from './telegram-client.js';
import { resolveTelegramChat } from './telegram-chats.js';
import { saveTelegramChat } from './config-file.js';
import {telegramDialogs,telegramHistoryPage,telegramInvoke} from './telegram-transport.js';
import {budgets,createOperation,withOperation,OperationError,type OperationContext,type OperationScope} from './operations.js';

type Common = {pts:number;qts:number;date:number;seq:number};
export class TelegramSource {
  private client?:TelegramClient;
  private connecting?:{promise:Promise<void>;scope:OperationScope;waiters:number;settled:boolean};
  private authFailure?:{sessionHash:string;error:OperationError};
  private candidate?:TelegramClient;
  private generation=0;
  private failures=0;
  private retryAt=0;
  private peers=new Map<string,Api.TypeInputPeer>();
  constructor(readonly config:Config,readonly store:Store,readonly onReply:(chat:string,id:string)=>Promise<void>,readonly alert:(text:string,deliveryId?:string,ctx?:OperationContext)=>Promise<void>,readonly continuing:()=>boolean=()=>true,
    private readonly options:{configPath?:string;createClient?:(session:string)=>TelegramClient;now?:()=>number}={}) {}
  async connect(ctx?:OperationContext):Promise<void> {
    return withOperation('connect',budgets.connect,ctx,async waiter=>{
      if(this.client&&this.client.connected!==false)return;
      // Let the pinned SDK finish its configured three reconnect attempts before replacing it.
      if(this.client?._sender?.isReconnecting){await telegramInvoke(this.client,new Api.updates.GetState(),waiter);return;}
      let attempt=this.connecting;
      if(!attempt){
        if(!this.authFailure&&(this.options.now?.()??Date.now())<this.retryAt)throw new OperationError('transport','Telegram: ожидаю следующую попытку подключения');
        const scope=createOperation('connect',budgets.connect);
        attempt={promise:Promise.resolve(),scope,waiters:0,settled:false};this.connecting=attempt;
        const current=attempt;
        current.promise=this.connectAttempt(scope).then(()=>{this.failures=0;this.retryAt=0;},error=>{
          if(error instanceof OperationError&&error.kind==='authentication'){this.retryAt=0;throw error;}
          if(!(scope.signal.aborted&&scope.signal.reason instanceof OperationError&&scope.signal.reason.kind==='cancelled')){
            const backoff=[1000,5000,15000,60000][Math.min(this.failures++,3)]!;this.retryAt=(this.options.now?.()??Date.now())+backoff;
          }
          throw error;
        }).finally(()=>{current.settled=true;scope.dispose();if(this.connecting===current)this.connecting=undefined;});
        void current.promise.catch(()=>{});
      }
      attempt.waiters++;
      let cancel!:()=>void;
      try{
        await new Promise<void>((resolve,reject)=>{
          cancel=()=>reject(waiter.signal.reason);
          if(waiter.signal.aborted)cancel();else waiter.signal.addEventListener('abort',cancel,{once:true});
          attempt!.promise.then(resolve,reject);
        });
        waiter.throwIfAborted();
      }finally{
        waiter.signal.removeEventListener('abort',cancel);attempt.waiters--;
        if(!attempt.waiters&&!attempt.settled){attempt.scope.abort(waiter.signal.reason??new OperationError('cancelled','Подключение больше не ожидается'));await attempt.promise.catch(()=>{});}
      }
    });
  }
  private async connectAttempt(ctx:OperationContext):Promise<void>{
    const generation=++this.generation,previous=this.client;this.client=undefined;
    if(previous)await telegramDeadline(typeof previous.destroy==='function'?previous.destroy():previous.disconnect(),budgets.cleanup).catch(()=>{});
    const saved=await readFile(join(secretsDir(),'telegram.session'),'utf8');ctx.throwIfAborted();
    const sessionHash=hash(saved.trim());if(this.authFailure?.sessionHash===sessionHash)throw this.authFailure.error;this.authFailure=undefined;
    const candidate=this.options.createClient?.(saved.trim())??await createTelegramClient(saved.trim());
    this.candidate=candidate;
    let disposing:Promise<void>|undefined;
    const dispose=()=>disposing??=(typeof candidate.destroy==='function'?candidate.destroy():candidate.disconnect());
    const cancel=()=>{void dispose().catch(()=>{});};
    ctx.signal.addEventListener('abort',cancel,{once:true});
    try{
      ctx.throwIfAborted();
      let connectExpired=false;
      const connectionTimer=setTimeout(()=>{connectExpired=true;cancel();},45000);
      try{await candidate.connect();if(connectExpired)throw new OperationError('deadline','Подключение Telegram не завершилось вовремя','request');}
      finally{clearTimeout(connectionTimer);}
      ctx.throwIfAborted();
      // Saved-session authorization uses a bounded raw RPC, rather than the helper's unbounded call.
      await telegramInvoke(candidate,new Api.updates.GetState(),ctx);
      candidate.updateManager.stop();
      const dialogs=await telegramDialogs(candidate,ctx),peers=new Map<string,Api.TypeInputPeer>();
      for(const chat of this.config.chats){const entity=dialogs.find(d=>d.id===chat.id)?.entity;if(!entity)throw new OperationError('permission',`Нет доступа к выбранному чату ${chat.id}`);peers.set(chat.id,getInputPeer(entity));}
      ctx.throwIfAborted();if(generation!==this.generation)throw new OperationError('cancelled','Подключение Telegram заменено');
      this.client=candidate;this.peers=peers;
    }catch(error){await dispose().catch(()=>{});if(error instanceof OperationError&&error.kind==='authentication')this.authFailure={sessionHash,error};if(ctx.signal.aborted)throw ctx.signal.reason;throw error;}
    finally{ctx.signal.removeEventListener('abort',cancel);if(this.candidate===candidate)this.candidate=undefined;}
  }
  listChats() {
    return this.config.chats.map(chat=>({...chat,allowQuestions:chat.allowQuestions!==false,connected:Boolean(this.client&&this.client.connected!==false&&this.peers.has(chat.id)),historyLoaded:Boolean(this.store.state.cursors[`tgHistory:${chat.id}`])}));
  }
  async addChat(reference:string,ctx?:OperationContext) {
    return withOperation('tool',budgets.addChat,ctx,async op=>{
    await this.connect(op);
    const {chat,peer}=await resolveTelegramChat(this.client!,reference,op);
    const alreadyAdded=this.config.chats.some(c=>c.id===chat.id);
    const saved=await saveTelegramChat(this.options.configPath??process.env.STUDY_CONFIG??'config.local.json',chat,this.config.ownerId);
    const index=this.config.chats.findIndex(c=>c.id===saved.id);
    if(index<0)this.config.chats.push(saved);else this.config.chats[index]=saved;
    this.peers.set(saved.id,peer);
    return {...saved,allowQuestions:saved.allowQuestions!==false,alreadyAdded,historyFrom:HISTORY_FROM,backfillPending:!this.store.state.cursors[`tgHistory:${saved.id}`]};
    });
  }
  async poll(parent?:OperationContext):Promise<{complete:boolean;initialComplete:boolean}> {
    const ctx=createOperation('source',budgets.telegramSlice,parent);
    try{await this.connect(ctx);const complete=await this.pollSlice(ctx);return {complete,initialComplete:complete&&this.config.chats.every(c=>Boolean(this.store.state.cursors[`tgHistory:${c.id}`]))};}
    catch(error){if(ctx.signal.aborted){if(!parent?.signal.aborted&&ctx.signal.reason instanceof OperationError&&ctx.signal.reason.kind==='deadline')return {complete:false,initialComplete:false};throw ctx.signal.reason;}throw error;}
    finally{ctx.dispose();}
  }
  private async pollSlice(ctx:OperationContext):Promise<boolean> {
    // A chat added during an await belongs to the next poll. In particular, its
    // channel difference must not run before initialization of its pts cursor.
    const peers=[...this.peers];
    if (!this.store.state.cursors.tgState) {
      const s=await telegramInvoke(this.client!,new Api.updates.GetState(),ctx);
      this.store.state.cursors.tgState=JSON.stringify({pts:s.pts,qts:s.qts,date:s.date,seq:s.seq});
      await this.store.save();
    }
    for(const [id,peer] of peers) {
      if(!this.continuing())return false;ctx.throwIfAborted();
      const key=`tgChannel:${id}`;
      if (peer instanceof Api.InputPeerChannel && !this.store.state.cursors[key]) {
        const full=await telegramInvoke(this.client!,new Api.channels.GetFullChannel({channel:new Api.InputChannel({channelId:peer.channelId,accessHash:peer.accessHash})}),ctx);
        if (!(full.fullChat instanceof Api.ChannelFull) || !full.fullChat.pts) throw new Error(`Не получен pts чата ${id}`);
        this.store.state.cursors[key]=String(full.fullChat.pts);await this.store.save();
      }
      if (!this.store.state.cursors[`tgHistory:${id}`]) {
        if(!await this.reconcile(id,ctx))return false;
        this.store.state.cursors[`tgHistory:${id}`]='1';await this.store.save();
      }
    }
    let resumedChannel=false;
    for(const [id,peer] of peers){
      if(peer instanceof Api.InputPeerChannel&&this.store.state.cursors[`tgResyncChannel:${id}`]){
        resumedChannel=true;if(!await this.channelDifference(id,peer,ctx))return false;
      }
    }
    // Finish authoritative history work before unrelated difference calls; the
    // next cycle reads deltas newer than the pinned channel counter.
    if(resumedChannel)return false;
    if(!await this.commonDifference(ctx))return false;
    for(const [id,peer] of peers) {if(!this.continuing())return false;ctx.throwIfAborted();if(peer instanceof Api.InputPeerChannel) if(!await this.channelDifference(id,peer,ctx))return false;}
    return true;
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
  private async reconcile(chat:string,ctx:OperationContext):Promise<boolean> {
    const key=`tgScan:${chat}`;
    type Scan={offset:number;found:number[];before:number[]};
    const saved=this.store.state.cursors[key];
    const scan:Scan=saved?JSON.parse(saved):{offset:0,found:[],before:Object.keys(this.store.state.seen).filter(k=>k.startsWith(`tg:${chat}:`)).map(k=>Number(k.split(':').at(-1)))};
    const found=new Set(scan.found);
    while(true){
      if(!this.continuing()||ctx.remainingMs()<50)return false;ctx.throwIfAborted();
      const page=await telegramHistoryPage(this.client!,this.peers.get(chat)!,scan.offset,100,ctx);
      let complete=page.complete;const batch:Api.TypeMessage[]=[];
      for(const message of page.messages){
        if('date' in message&&message.date<+new Date(HISTORY_FROM)/1000){complete=true;break;}
        found.add(message.id);batch.push(message);
      }
      await this.messages(batch);
      // Persist progress only after all messages from this page are durably enqueued.
      scan.offset=page.nextOffset;scan.found=[...found];this.store.state.cursors[key]=JSON.stringify(scan);await this.store.save();
      if(complete){await this.deleted(chat,scan.before.filter(id=>!found.has(id)));delete this.store.state.cursors[key];this.store.state.cursors[`tgHistory:${chat}`]='1';await this.store.save();return true;}
    }
  }
  private async commonDifference(ctx:OperationContext):Promise<boolean> {
    type Resync={fresh:Common;chats:string[];done:string[];noticeSent?:boolean};
    for(let n=0;n<100;n++) {
      if(!this.continuing())return false;ctx.throwIfAborted();
      const s=JSON.parse(this.store.state.cursors.tgState!) as Common;
      const pending=this.store.state.cursors.tgResync;
      let resync:Resync|undefined=pending?JSON.parse(pending):undefined;
      // A persisted generation already owns its baseline; another difference RPC
      // must not prevent the remaining history pages from making progress.
      const d=resync?undefined:await telegramInvoke(this.client!,new Api.updates.GetDifference({pts:s.pts,date:s.date,qts:s.qts}),ctx);
      if(d instanceof Api.updates.DifferenceTooLong)resync={fresh:await telegramInvoke(this.client!,new Api.updates.GetState(),ctx),chats:[...this.peers.keys()],done:[]};
      if(resync){
        this.store.state.cursors.tgResync=JSON.stringify(resync);await this.store.save();
        if(!resync.noticeSent){
          await this.alert('Telegram: сервер не отдал весь пропущенный поток. Перепроверяю доступную историю; удаленные сведения могут быть недоступны.',`tg-resync:${hash(JSON.stringify(resync.fresh)).slice(0,24)}`,ctx);
          resync.noticeSent=true;this.store.state.cursors.tgResync=JSON.stringify(resync);await this.store.save();
        }
        for(const id of resync.chats){if(resync.done.includes(id))continue;if(!await this.reconcile(id,ctx))return false;resync.done.push(id);this.store.state.cursors.tgResync=JSON.stringify(resync);await this.store.save();}
        this.store.state.cursors.tgState=JSON.stringify(resync.fresh);delete this.store.state.cursors.tgResync;await this.store.save();return true;
      }
      if(!d||d instanceof Api.updates.DifferenceTooLong)throw new OperationError('invariant','Отсутствует состояние Telegram difference');
      if(d instanceof Api.updates.DifferenceEmpty) {
        this.store.state.cursors.tgState=JSON.stringify({...s,date:d.date,seq:d.seq});await this.store.save();return true;
      }
      await this.messages(d.newMessages);await this.updates(d.otherUpdates);
      const next=d instanceof Api.updates.DifferenceSlice ? d.intermediateState : d.state;
      this.store.state.cursors.tgState=JSON.stringify({pts:next.pts,qts:next.qts,date:next.date,seq:next.seq});await this.store.save();
      if(d instanceof Api.updates.Difference)return true;
    }
    return false;
  }
  private async channelDifference(id:string,peer:Api.InputPeerChannel,ctx:OperationContext):Promise<boolean> {
    type Resync={pts:number;noticeSent?:boolean};
    for(let n=0;n<100;n++) {
      if(!this.continuing())return false;ctx.throwIfAborted();
      const key=`tgResyncChannel:${id}`,pending=this.store.state.cursors[key];
      const decoded:Resync|number|undefined=pending?JSON.parse(pending):undefined;
      let resync:Resync|undefined=typeof decoded==='number'?{pts:decoded}:decoded;
      const d=resync?undefined:await telegramInvoke(this.client!,new Api.updates.GetChannelDifference({channel:new Api.InputChannel({channelId:peer.channelId,accessHash:peer.accessHash}),filter:new Api.ChannelMessagesFilterEmpty(),pts:Number(this.store.state.cursors[`tgChannel:${id}`]),limit:100,force:true}),ctx);
      if(d instanceof Api.updates.ChannelDifferenceTooLong){
        if(!(d.dialog instanceof Api.Dialog)||!d.dialog.pts)throw new Error('Нет pts после ChannelDifferenceTooLong');
        resync={pts:d.dialog.pts};
      }
      let pts:number;
      if(resync){
        this.store.state.cursors[key]=JSON.stringify(resync);await this.store.save();
        if(!resync.noticeSent){
          await this.alert(`Чат ${id}: часть обновлений недоступна. Перепроверяю текущую историю.`,`tg-channel-resync:${id}:${resync.pts}`,ctx);
          resync.noticeSent=true;this.store.state.cursors[key]=JSON.stringify(resync);await this.store.save();
        }
        if(!await this.reconcile(id,ctx))return false;
        pts=resync.pts;delete this.store.state.cursors[key];
      }else{
        if(!d||d instanceof Api.updates.ChannelDifferenceTooLong)throw new OperationError('invariant','Отсутствует состояние Telegram channel difference');
        pts=d.pts;if(d instanceof Api.updates.ChannelDifference){await this.messages(d.newMessages);await this.updates(d.otherUpdates);}
      }
      this.store.state.cursors[`tgChannel:${id}`]=String(pts);await this.store.save();
      if(!d||d.final)return true;
    }
    return false;
  }
  async history(chat:string,limit=50,ctx?:OperationContext):Promise<Source[]> {
    return withOperation('tool',budgets.history,ctx,async op=>{await this.connect(op);
    if (!this.peers.has(chat)) throw new Error('Чат не разрешен');
    const page=await telegramHistoryPage(this.client!,this.peers.get(chat)!,0,Math.min(Math.max(limit,1),100),op);
    return page.messages.filter((m):m is Api.Message=>m instanceof Api.Message&&Boolean(m.message)).map(m=>this.source(chat,m));
    });
  }
  async question(chat:string,text:string,randomId:string,ctx?:OperationContext):Promise<string> {
    return withOperation('approval',budgets.question,ctx,async op=>{await this.connect(op);
    if(this.config.chats.find(c=>c.id===chat)?.allowQuestions===false)throw new Error('Чат подключён только для чтения; отправка вопросов не разрешена');
    const peer=this.peers.get(chat);if(!peer) throw new Error('Чат не разрешен');
    const r=await telegramInvoke(this.client!,new Api.messages.SendMessage({peer,message:text,randomId:bigInt(randomId)}),op);
    if(r instanceof Api.UpdateShortSentMessage) return String(r.id);
    if('updates' in r) for(const u of r.updates) {
      if(u instanceof Api.UpdateMessageID && u.randomId?.equals(bigInt(randomId))) return String(u.id);
      if((u instanceof Api.UpdateNewMessage || u instanceof Api.UpdateNewChannelMessage) && u.message instanceof Api.Message) return String(u.message.id);
    }
    throw new Error('Отправка не подтверждена id сообщения; повторю с тем же random_id');
    });
  }
  async close():Promise<void> {++this.generation;this.connecting?.scope.abort(new OperationError('cancelled','Telegram остановлен','stop'));const candidate=this.candidate;if(candidate)void (typeof candidate.destroy==='function'?candidate.destroy():candidate.disconnect()).catch(()=>{});const client=this.client;this.client=undefined;if(client)await telegramDeadline(typeof client.destroy==='function'?client.destroy():client.disconnect(),budgets.cleanup).catch(()=>{});await this.connecting?.promise.catch(()=>{});}
}
