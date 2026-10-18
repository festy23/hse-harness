import type {OperationContext} from '../operations.js';
import {randomUUID} from 'node:crypto';
import type {Store,NpmUpdateState} from '../store.js';
import type {TelegramBot,BotUpdate,Buttons} from '../bot.js';
import {latestRelease,compareVersions,type AvailableRelease} from './releases.js';
import type {UpdateRuntime,UpdateSnapshot} from './runtime.js';
import {updatePanel} from './view.js';

const DAY=24*3600_000,HOUR=3600_000;
const active=(q:NpmUpdateState['request'])=>q&&['authorizing','pending','installing','awaiting-apply'].includes(q.phase);
type UpdateRequest=NonNullable<NpmUpdateState['request']>;
/** Native owner settings and update operations, independent of LLM/source readiness. */
export class TelegramUpdates {
  private busy=false;
  constructor(private readonly store:Store,private readonly bot:Pick<TelegramBot,'identity'|'send'|'isOwner'>,private readonly runtime:UpdateRuntime,
    private readonly workerId:string,private readonly signal:AbortSignal,private readonly latest:(ctx?:OperationContext)=>Promise<AvailableRelease>=ctx=>latestRelease(fetch,ctx),private readonly now:()=>number=Date.now) {}
  private state():NpmUpdateState {
    const state=this.store.state.npmUpdates??={};
    if(state.botIdentity!==this.bot.identity){state.botIdentity=this.bot.identity;delete state.offer;delete state.controls;delete state.lastOfferedAt;delete state.pendingNotice;}
    return state;
  }
  private ensureOffer(release:AvailableRelease){
    const state=this.state();
    if(state.offer?.version!==release.version||state.offer.integrity!==release.integrity)state.offer={...release,id:randomUUID()};
    return state.offer!;
  }
  private buttons(snapshot:UpdateSnapshot,offerId?:string):Buttons {
    const state=this.state();
    if(!state.controls||state.controls.enabled!==snapshot.automaticUpdates)state.controls={id:randomUUID(),enabled:snapshot.automaticUpdates};
    const buttons:Buttons=[];
    if(offerId&&!active(state.request))buttons.push([{text:'Обновить',callback_data:`hse_update:${offerId}`}]);
    buttons.push([{text:snapshot.automaticUpdates?'Выключить автообновление':'Включить автообновление',callback_data:`hse_auto:${snapshot.automaticUpdates?'off':'on'}:${state.controls.id}`}]);
    return buttons;
  }
  private async send(text:string,buttons?:Buttons,id?:string,ctx?:OperationContext):Promise<boolean>{
    try{await this.bot.send(text,buttons,id,ctx);return true;}
    catch{await this.store.flush();return false;}
  }
  private async panel(snapshot:UpdateSnapshot,delivery:string,ctx?:OperationContext,registryUnavailable=false,prefix?:string){
    const state=this.state(),release=state.latest;
    const offer=release&&compareVersions(release.version,snapshot.runningVersion)>0?this.ensureOffer(release):undefined;
    const buttons=this.buttons(snapshot,offer?.id);
    await this.store.save();
    const text=updatePanel(snapshot,release,state.request,registryUnavailable);
    await this.bot.send(prefix?`${prefix}\n\n${text}`:text,buttons,delivery,ctx);
  }
  private async pending(snapshot:UpdateSnapshot,ctx?:OperationContext):Promise<void>{
    const state=this.state(),notice=state.pendingNotice;if(!notice)return;
    if(compareVersions(snapshot.runningVersion,notice.version)>=0){delete state.pendingNotice;await this.store.save();return;}
    const buttons=this.buttons(snapshot,notice.offerId);await this.store.save();
    if(await this.send(notice.text,buttons,notice.id,ctx)){delete state.pendingNotice;await this.store.save();}
  }
  private async offer(snapshot:UpdateSnapshot,ctx?:OperationContext){
    const state=this.state(),release=state.latest;
    if(!release||compareVersions(release.version,snapshot.runningVersion)<=0)return;
    if(state.lastOfferedAt!==undefined&&this.now()-state.lastOfferedAt<DAY)return;
    const offer=this.ensureOffer(release);
    const automatic=snapshot.automaticUpdates&&!snapshot.quarantined.includes(release.version)&&
      !(state.request?.phase==='failed'&&!state.request.cancelled&&state.request.version===release.version&&state.request.integrity===release.integrity);
    const text=`Доступна новая версия HSE HARNESS: ${snapshot.runningVersion} → ${release.version}.\nРекомендую обновиться: установи актуальные исправления.${automatic?'\nАвтообновление включено. Подготовлю совместимый выпуск и дождусь завершения текущих операций.':'\nНажми «Обновить», чтобы установить её.'}\nПамять и очередь сохранятся.`;
    state.pendingNotice={id:`npm-offer:${state.botIdentity}:${randomUUID()}`,text,offerId:offer.id,version:release.version};
    state.lastOfferedAt=this.now();await this.store.save();await this.pending(snapshot,ctx);
  }
  async checkManually(update:BotUpdate,ctx?:OperationContext):Promise<void> {
    if(!this.bot.isOwner(update))return;
    const delivery=`npm-command:${this.bot.identity}:${update.update_id}`;
    const snapshot=await this.runtime.snapshot();
    if(!snapshot){await this.bot.send('Обновление из Telegram доступно при постоянном запуске установленного npm-пакета.',undefined,delivery,ctx);return;}
    let registryUnavailable=false,release:AvailableRelease|undefined;
    try{release=await this.latest(ctx);}catch{registryUnavailable=true;}
    const state=this.state();state.checkFailed=registryUnavailable;
    if(release){state.latest=release;state.checkedAt=this.now();}
    await this.store.save();
    await this.panel(snapshot,delivery,ctx,registryUnavailable);
  }
  private async automaticSetting(update:BotUpdate,data:string,ctx?:OperationContext):Promise<void>{
    const delivery=`npm-setting:${this.bot.identity}:${update.update_id}`,state=this.state(),controls=state.controls;
    if(!controls||data!==`hse_auto:${controls.enabled?'off':'on'}:${controls.id}`){
      await this.bot.send('Эта кнопка устарела. Открой /updates для актуальных настроек.',undefined,delivery,ctx);return;
    }
    if(!await this.runtime.snapshot()){
      await this.bot.send('Настройка доступна при постоянном запуске установленного npm-пакета.',undefined,delivery,ctx);return;
    }
    const enabled=!controls.enabled;
    await this.runtime.setAutomatic(enabled);
    const snapshot=await this.runtime.snapshot();if(!snapshot)return;
    // Explicit values plus a fresh nonce make retries idempotent and old buttons inert.
    if(state.controls===controls)delete state.controls;
    await this.store.save();
    const unstarted=state.request?.automatic&&['authorizing','pending'].includes(state.request.phase);
    const inProgress=active(state.request)?!enabled&&unstarted?' Ещё не начатая автоматическая установка отменится.':' Уже начатое обновление будет завершено безопасно.':'';
    await this.panel(snapshot,delivery,ctx,state.checkFailed===true,`${enabled?'Автообновление включено.':'Автообновление выключено.'}${inProgress}`);
  }
  private async begin(release:AvailableRelease,automatic:boolean,ctx?:OperationContext){
    const state=this.state();if(active(state.request)||this.signal.aborted)return;
    const q:UpdateRequest={...release,id:randomUUID(),workerId:this.workerId,phase:'authorizing',created:this.now(),automatic};
    state.request=q;await this.store.save();
    await this.runtime.grant(q.id);
    q.phase='pending';await this.store.save();
    await this.send(`${automatic?'Автоматически запускаю':'Запускаю'} обновление до ${release.version}. Это может занять несколько минут; сообщу после переключения.`,undefined,`npm-start:${q.id}`,ctx);
  }
  async callback(update:BotUpdate,ctx?:OperationContext):Promise<boolean> {
    const data=update.callback_query?.data;
    if(!data?.startsWith('hse_update:')&&!data?.startsWith('hse_auto:'))return false;
    if(!this.bot.isOwner(update))return true;
    if(data.startsWith('hse_auto:')){await this.automaticSetting(update,data,ctx);return true;}
    const reply=(text:string)=>this.bot.send(text,undefined,`npm-callback:${this.bot.identity}:${update.update_id}`,ctx);
    const state=this.state(),offer=state.offer;
    if(!offer||data!==`hse_update:${offer.id}`){await reply('Эта кнопка устарела. Проверь новую версию через /updates.');return true;}
    const snapshot=await this.runtime.snapshot();if(!snapshot)return true;
    if(compareVersions(snapshot.runningVersion,offer.version)>=0){await reply(`Уже работает версия ${snapshot.runningVersion}.`);return true;}
    if(active(state.request)){await reply(`Обновление до ${state.request!.version} уже выполняется.`);return true;}
    let latest;
    try{latest=await this.latest(ctx);}catch{await reply('Не удалось проверить выбранную версию в npm. Попробуй позже.');return true;}
    if(active(state.request)){await reply(`Обновление до ${state.request!.version} уже выполняется.`);return true;}
    state.latest=latest;state.checkedAt=this.now();state.checkFailed=false;
    if(latest.version!==offer.version||latest.integrity!==offer.integrity){await this.panel(snapshot,`npm-changed:${this.bot.identity}:${update.update_id}`,ctx);return true;}
    await this.begin(offer,false,ctx);return true;
  }
  private async runRequest(q:UpdateRequest,snapshot:UpdateSnapshot):Promise<void>{
    const state=this.state();
    if(q.automatic&&['authorizing','pending'].includes(q.phase)&&!snapshot.automaticUpdates){
      await this.fail(q,{code:'AUTOMATIC_UPDATES_DISABLED'});return;
    }
    if(q.automatic&&snapshot.quarantined.includes(q.version)){await this.fail(q);return;}
    if(q.phase==='authorizing'){await this.runtime.grant(q.id);q.phase='pending';await this.store.save();}
    if(snapshot.stable&&compareVersions(snapshot.runningVersion,q.version)>=0){await this.runtime.restore(q.id);q.phase='completed';delete state.offer;delete state.pendingNotice;await this.store.save();return;}
    if(q.phase==='awaiting-apply'&&!snapshot.updatesEnabled){await this.fail(q);return;}
    if(q.phase!=='pending'&&snapshot.quarantined.includes(q.version)&&!snapshot.retryPending){await this.fail(q);return;}
    if(q.phase==='pending'&&snapshot.quarantined.includes(q.version)){
      q.phase='installing';q.workerId=this.workerId;await this.store.save();
      try{await this.runtime.install(q,this.signal);}catch(error){if(!this.signal.aborted)await this.fail(q,error);return;}
      q.phase='awaiting-apply';await this.store.save();return;
    }
    if(compareVersions(snapshot.installedVersion,q.version)>=0){q.phase='awaiting-apply';await this.store.save();return;}
    if(q.phase==='installing'){if(q.workerId!==this.workerId)await this.fail(q);return;}
    if(q.phase==='awaiting-apply'){await this.fail(q);return;}
    q.phase='installing';q.workerId=this.workerId;await this.store.save();
    try{await this.runtime.install(q,this.signal);}
    catch(error){if(this.signal.aborted)return;await this.fail(q,error);}
    if(q.phase==='installing'){q.phase='awaiting-apply';await this.store.save();}
  }
  async tick():Promise<void> {
    if(this.busy||this.signal.aborted)return;
    this.busy=true;
    try {
      const snapshot=await this.runtime.snapshot();if(!snapshot)return;
      const state=this.state(),q=state.request;
      if(q&&active(q)){await this.runRequest(q,snapshot);return;}
      if(state.pendingNotice)await this.pending(snapshot);
      if(!state.checkedAt||this.now()-state.checkedAt>=HOUR){
        let release;
        try{release=await this.latest();}
        catch{state.checkFailed=true;state.checkedAt=this.now()-HOUR+60_000;await this.store.save();return;}
        state.latest=release;state.checkedAt=this.now();state.checkFailed=false;await this.store.save();
      }
      if(active(state.request))return;
      const beforeOffer=await this.runtime.snapshot();if(!beforeOffer)return;
      await this.offer(beforeOffer);
      // Re-read policy after network awaits: a simultaneous owner disable wins.
      const current=await this.runtime.snapshot(),release=state.latest;
      if(!current?.automaticUpdates||!current.stable||!release||this.signal.aborted||active(state.request))return;
      if(compareVersions(release.version,current.runningVersion)<=0||current.quarantined.includes(release.version))return;
      if(state.request?.phase==='failed'&&!state.request.cancelled&&state.request.version===release.version&&state.request.integrity===release.integrity)return;
      await this.begin(release,true);
    }finally{this.busy=false;}
  }
  private async fail(q:UpdateRequest,error?:unknown){
    await this.runtime.restore(q.id);q.phase='failed';
    const state=this.state(),offer=this.ensureOffer(q);
    const code=(error as {code?:string}|undefined)?.code;
    q.cancelled=code==='AUTOMATIC_UPDATES_DISABLED';
    const detail=code==='RUNTIME_UPGRADE_REQUIRED'?' Для этой версии требуется обслуживаемое обновление runtime на VPS.':code==='AUTOMATIC_UPDATES_DISABLED'?' Автообновление выключено до начала установки.':code==='AUTOMATIC_UPDATE_HELD'?' Повтор этой версии после отката требует ручного подтверждения.':'';
    state.pendingNotice={id:`npm-failed:${q.id}`,text:`Обновление до ${q.version} не завершено.${detail} Текущая версия продолжает работать. /updates — настройки; кнопка — повторить попытку.`,offerId:offer.id,version:q.version};
    await this.store.save();
    const snapshot=await this.runtime.snapshot();if(snapshot)await this.pending(snapshot);
  }
}
