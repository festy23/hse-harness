import {randomUUID} from 'node:crypto';
import type {Store,NpmUpdateState} from '../store.js';
import type {TelegramBot,BotUpdate} from '../bot.js';
import {latestRelease,compareVersions,type AvailableRelease} from './releases.js';
import type {UpdateRuntime,UpdateSnapshot} from './runtime.js';

const DAY=24*3600_000,HOUR=3600_000;
const active=(q:NpmUpdateState['request'])=>q&&['authorizing','pending','installing','awaiting-apply'].includes(q.phase);
/** Native operations state and owner callbacks; independent of LLM and source readiness. */
export class TelegramUpdates {
  private busy=false;
  constructor(private readonly store:Store,private readonly bot:Pick<TelegramBot,'identity'|'send'|'isOwner'>,private readonly runtime:UpdateRuntime,
    private readonly workerId:string,private readonly signal:AbortSignal,private readonly latest:()=>Promise<AvailableRelease>=latestRelease,private readonly now:()=>number=Date.now) {}
  private state():NpmUpdateState {
    const state=this.store.state.npmUpdates??={};
    if(state.botIdentity!==this.bot.identity){state.botIdentity=this.bot.identity;delete state.offer;delete state.lastOfferedAt;delete state.pendingNotice;}
    return state;
  }
  private buttons(id:string){return [[{text:'Обновить',callback_data:`hse_update:${id}`}]];}
  private async send(text:string,buttons?:ReturnType<TelegramUpdates['buttons']>,id?:string):Promise<boolean>{
    try{await this.bot.send(text,buttons,id);return true;}
    catch{await this.store.flush();return false;}
  }
  private async pending(snapshot:UpdateSnapshot):Promise<void>{
    const state=this.state(),notice=state.pendingNotice;if(!notice)return;
    if(compareVersions(snapshot.runningVersion,notice.version)>=0){delete state.pendingNotice;await this.store.save();return;}
    if(await this.send(notice.text,this.buttons(notice.offerId),notice.id)){delete state.pendingNotice;await this.store.save();}
  }
  private async offer(snapshot:UpdateSnapshot,manual=false,delivery?:string){
    const state=this.state(),release=state.latest;
    if(!release||compareVersions(release.version,snapshot.runningVersion)<=0){if(manual)await this.bot.send(`Работающая версия: ${snapshot.runningVersion}. Новых доступных версий нет.`,undefined,delivery);return;}
    if(!manual&&state.lastOfferedAt!==undefined&&this.now()-state.lastOfferedAt<DAY)return;
    if(state.offer?.version!==release.version||state.offer.integrity!==release.integrity)state.offer={...release,id:randomUUID()};
    await this.store.save();
    const id=state.offer!.id;
    const text=`Доступна новая версия HSE HARNESS: ${snapshot.runningVersion} → ${release.version}.\nНажми «Обновить», чтобы установить её. Память и очередь сохранятся.${snapshot.updatesEnabled?'':'\nПрименение будет разрешено только для этого обновления; прежняя настройка затем восстановится.'}`;
    state.pendingNotice={id:delivery??`npm-offer:${state.botIdentity}:${randomUUID()}`,text,offerId:id,version:release.version};
    state.lastOfferedAt=this.now();await this.store.save();await this.pending(snapshot);
  }
  async checkManually(update:BotUpdate):Promise<void> {
    if(!this.bot.isOwner(update))return;
    const snapshot=await this.runtime.snapshot();
    if(!snapshot){await this.bot.send('Обновление из Telegram доступно при постоянном запуске установленного npm-пакета.');return;}
    const state=this.state();
    if(active(state.request)){await this.bot.send(`Обновление до ${state.request!.version} уже выполняется. /status — состояние.`);return;}
    let release;
    try{release=await this.latest();}
    catch{await this.bot.send('Не удалось проверить npm. Попробуй /updates позже.');return;}
    if(active(state.request)){await this.send(`Обновление до ${state.request!.version} уже выполняется.`);return;}
    state.latest=release;state.checkedAt=this.now();await this.store.save();
    await this.offer(snapshot,true,`npm-manual:${this.bot.identity}:${update.update_id}`);
  }
  async callback(update:BotUpdate):Promise<boolean> {
    const data=update.callback_query?.data;
    if(!data?.startsWith('hse_update:'))return false;
    if(!this.bot.isOwner(update))return true;
    const state=this.state(),offer=state.offer;
    if(!offer||data!==`hse_update:${offer.id}`){await this.bot.send('Эта кнопка устарела. Проверь новую версию через /updates.');return true;}
    const snapshot=await this.runtime.snapshot();if(!snapshot)return true;
    if(compareVersions(snapshot.runningVersion,offer.version)>=0){await this.bot.send(`Уже работает версия ${snapshot.runningVersion}.`);return true;}
    if(active(state.request)){await this.bot.send(`Обновление до ${state.request!.version} уже выполняется.`);return true;}
    let latest;
    try{latest=await this.latest();}catch{await this.bot.send('Не удалось проверить выбранную версию в npm. Попробуй позже.');return true;}
    if(active(state.request)){await this.bot.send(`Обновление до ${state.request!.version} уже выполняется.`);return true;}
    if(latest.version!==offer.version||latest.integrity!==offer.integrity){state.latest=latest;await this.store.save();await this.offer(snapshot,true);return true;}
    state.request={...offer,id:randomUUID(),workerId:this.workerId,phase:'authorizing',created:this.now()};await this.store.save();
    await this.runtime.grant(state.request.id);
    state.request.phase='pending';await this.store.save();
    await this.send(`Запускаю обновление до ${offer.version}. Это может занять несколько минут; сообщу после переключения.`,undefined,`npm-start:${state.request.id}`);
    return true;
  }
  async tick():Promise<void> {
    if(this.busy||this.signal.aborted)return;
    this.busy=true;
    try {
      const snapshot=await this.runtime.snapshot();if(!snapshot)return;
      const state=this.state(),q=state.request;
      if(q&&active(q)){
        if(q.phase==='authorizing'){await this.runtime.grant(q.id);q.phase='pending';await this.store.save();}
        if(snapshot.stable&&compareVersions(snapshot.runningVersion,q.version)>=0){await this.runtime.restore(q.id);q.phase='completed';delete state.offer;delete state.pendingNotice;await this.store.save();return;}
        if(q.phase==='awaiting-apply'&&!snapshot.updatesEnabled){await this.fail(q);return;}
        if(q.phase!=='pending'&&snapshot.quarantined.includes(q.version)&&!snapshot.retryPending){await this.fail(q);return;}
        if(q.phase==='pending'&&snapshot.quarantined.includes(q.version)){
          // Preflight the pinned release before asking the supervisor to retry it.
          q.phase='installing';q.workerId=this.workerId;await this.store.save();
          try{await this.runtime.install(q,this.signal);}catch{if(!this.signal.aborted)await this.fail(q);return;}
          q.phase='awaiting-apply';await this.store.save();return;
        }
        if(compareVersions(snapshot.installedVersion,q.version)>=0){q.phase='awaiting-apply';await this.store.save();return;}
        if(q.phase==='installing'){if(q.workerId!==this.workerId)await this.fail(q);return;}
        if(q.phase==='awaiting-apply'){await this.fail(q);return;}
        q.phase='installing';q.workerId=this.workerId;await this.store.save();
        try{await this.runtime.install(q,this.signal);}
        catch(error){if(this.signal.aborted)return;await this.fail(q);}
        if(q.phase==='installing'){q.phase='awaiting-apply';await this.store.save();}
        return;
      }
      if(state.pendingNotice){await this.pending(snapshot);return;}
      if(!state.checkedAt||this.now()-state.checkedAt>=HOUR){
        let release;
        try{release=await this.latest();}
        catch{state.checkedAt=this.now()-HOUR+60_000;await this.store.save();return;}
        state.latest=release;state.checkedAt=this.now();await this.store.save();
      }
      if(active(state.request))return;
      await this.offer(snapshot);
    }finally{this.busy=false;}
  }
  private async fail(q:NonNullable<NpmUpdateState['request']>){
    await this.runtime.restore(q.id);q.phase='failed';
    const state=this.state();state.offer??={version:q.version,integrity:q.integrity,id:randomUUID()};
    state.pendingNotice={id:`npm-failed:${q.id}`,text:`Обновление до ${q.version} не завершено. Текущая версия продолжает работать. /status — состояние; кнопка — повторить попытку.`,offerId:state.offer.id,version:q.version};
    await this.store.save();
    const snapshot=await this.runtime.snapshot();if(snapshot)await this.pending(snapshot);
  }
}
