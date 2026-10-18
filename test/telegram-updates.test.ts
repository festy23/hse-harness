import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {TelegramBot,type BotUpdate} from '../src/bot.js';
import {TelegramUpdates} from '../src/updates/telegram.js';
import {latestRelease,type AvailableRelease} from '../src/updates/releases.js';
import type {UpdateRuntime,UpdateSnapshot} from '../src/updates/runtime.js';
const integrity='sha512-'+Buffer.alloc(64,1).toString('base64');
const release=(version='0.2.3'):AvailableRelease=>({version,integrity});
const owner=(id=1,data?:string,from=1,type='private'):BotUpdate=>data?{update_id:id,callback_query:{id:String(id),from:{id:from},message:{chat:{id:from,type}},data}}:{update_id:id,message:{message_id:id,from:{id:from},chat:{id:from,type},text:'/updates'}};
class Bot extends TelegramBot {
  messages:any[]=[];down=false;
  override get identity(){return 'telegram:1';}
  override async call<T>(method:string,args:unknown):Promise<T>{assert.equal(method,'sendMessage');if(this.down)throw Error('connection lost');this.messages.push(args);return {message_id:this.messages.length} as T;}
}
async function fixture(t:any){
  const dir=await mkdtemp(join(tmpdir(),'hse-tg-updates-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let generation=1;let store=new Store(dir);await store.load();let bot=new Bot(1,store);
  let time=Date.parse('2026-10-14T20:59:00Z'),latest=release(),calls=0,installs=0,grants=0,restores=0,registryDown=false,policyChanges=0;
  const snapshot:UpdateSnapshot={runningVersion:'0.2.2',installedVersion:'0.2.2',updatesEnabled:true,automaticUpdates:false,stable:true,quarantined:[]};
  const runtime:UpdateRuntime={snapshot:async()=>snapshot,setAutomatic:async enabled=>{policyChanges++;snapshot.automaticUpdates=enabled;},grant:async()=>{grants++;snapshot.updatesEnabled=true;},restore:async()=>{restores++;},install:async r=>{installs++;snapshot.installedVersion=r.version;}};
  const abort=new AbortController();
  const make=(id='worker1')=>new TelegramUpdates(store,bot,runtime,id,abort.signal,async()=>{calls++;if(registryDown)throw Error('npm offline');return latest;},()=>time);
  return {dir,store,bot,runtime,snapshot,abort,make,get counts(){return {calls,installs,grants,restores,policyChanges};},setRegistryDown:()=>{registryDown=true;},setTime:(n:number)=>{time+=n;},setLatest:(r:AvailableRelease)=>{latest=r;},button:()=>bot.messages.at(-1).reply_markup.inline_keyboard[0][0].callback_data,automaticButton:()=>bot.messages.at(-1).reply_markup.inline_keyboard.flat().find((b:any)=>b.callback_data.startsWith('hse_auto:')).callback_data,restart:async()=>{store=new Store(dir);await store.load();bot=new Bot(1,store);return {store,bot,updates:make('worker'+(++generation))};}};
}

test('hourly discovery offers a native inline button once per 24h across versions and restarts, never installs automatically',async t=>{
  const f=await fixture(t),u=f.make();await u.tick();
  assert.equal(f.bot.messages.length,1);assert.equal(f.bot.messages[0].reply_markup.inline_keyboard[0][0].text,'Обновить');
  assert.ok(Buffer.byteLength(f.button())<=64);assert.equal(f.counts.installs,0);
  f.setTime(3600_000);f.setLatest(release('0.2.4'));await u.tick();assert.equal(f.counts.calls,2);assert.equal(f.bot.messages.length,1);
  const resumed=await f.restart();await resumed.updates.tick();assert.equal(resumed.bot.messages.length,0);
  f.setTime(23*3600_000);await resumed.updates.tick();assert.equal(resumed.bot.messages.length,1);assert.match(resumed.bot.messages[0].text,/0.2.4/);assert.equal(f.counts.installs,0);
});

test('only the owner private chat can approve a current button; duplicate concurrent callbacks install once',async t=>{
  const f=await fixture(t),u=f.make();await u.tick();const button=f.button();
  await u.callback(owner(2,button,2));await u.callback(owner(3,button,1,'group'));await u.callback(owner(4,'hse_update:forged'));assert.equal(f.counts.grants,0);
  await Promise.all([u.callback(owner(5,button)),u.callback(owner(6,button))]);assert.equal(f.counts.grants,1);
  const resumed=await f.restart();await resumed.updates.tick();assert.equal(f.counts.installs,1);assert.equal(resumed.store.state.npmUpdates?.request?.phase,'awaiting-apply');
  await resumed.updates.tick();assert.equal(f.counts.installs,1);
  f.snapshot.runningVersion='0.2.3';f.snapshot.stable=false;await resumed.updates.tick();assert.notEqual(resumed.store.state.npmUpdates?.request?.phase,'completed');
  f.snapshot.stable=true;await resumed.updates.tick();assert.equal(resumed.store.state.npmUpdates?.request?.phase,'completed');assert.equal(f.counts.restores,1);
  assert.equal(resumed.bot.messages.length,0,'success notice belongs to the existing supervisor');
});

test('changed release identity refreshes the offer and requires a new approval; /updates bypasses daily cooldown',async t=>{
  const f=await fixture(t),u=f.make();await u.tick();const old=f.button();f.setLatest(release('0.2.4'));
  await u.callback(owner(2,old));assert.equal(f.counts.installs,0);assert.notEqual(f.button(),old);
  await u.checkManually(owner(3));assert.match(f.bot.messages.at(-1).text,/0.2.4/);
  await u.callback(owner(4,old));assert.equal(f.counts.grants,0);
});

test('lost Bot API response keeps one durable delivery identity across midnight and restart',async t=>{
  const f=await fixture(t),u=f.make();f.bot.down=true;await u.tick();const pending=f.store.state.npmUpdates!.pendingNotice!;
  assert.ok(pending);const keys=Object.keys(f.store.state.outbox);assert.equal(keys.length,1);
  f.setTime(120_000);const resumed=await f.restart();await resumed.updates.tick();
  assert.equal(resumed.bot.messages.length,1);assert.equal(resumed.store.state.npmUpdates?.pendingNotice,undefined);
  assert.deepEqual(Object.keys(resumed.store.state.outbox),keys);assert.equal(resumed.store.state.outbox[pending.id]!.chunks[0]!.state,'sent');
  await resumed.updates.tick();assert.equal(resumed.bot.messages.length,1);
});

test('authorizing crash recovers; interrupted installation fails visibly and can be explicitly retried',async t=>{
  const f=await fixture(t),u=f.make();await u.tick();await u.callback(owner(2,f.button()));
  const q=f.store.state.npmUpdates!.request!;q.phase='authorizing';await f.store.save();
  let resumed=await f.restart();await resumed.updates.tick();assert.equal(f.counts.installs,1);assert.equal(f.counts.grants,2);
  f.snapshot.installedVersion='0.2.2';resumed.store.state.npmUpdates!.request!.phase='installing';await resumed.store.save();
  resumed=await f.restart();await resumed.updates.tick();assert.equal(resumed.store.state.npmUpdates?.request?.phase,'failed');assert.match(resumed.bot.messages[0].text,/не завершено/);
  const button=resumed.bot.messages[0].reply_markup.inline_keyboard[0][0].callback_data;
  await resumed.updates.callback(owner(3,button));await resumed.updates.tick();assert.equal(f.counts.installs,2);
});

test('quarantined release is retried only on explicit approval and waits for supervisor consumption',async t=>{
  const f=await fixture(t),u=f.make();await u.tick();f.snapshot.quarantined=['0.2.3'];f.snapshot.installedVersion='0.2.3';
  f.runtime.install=async()=>{f.snapshot.retryPending=true;};
  await u.callback(owner(2,f.button()));await u.tick();await u.tick();assert.equal(f.store.state.npmUpdates?.request?.phase,'awaiting-apply');
  f.snapshot.retryPending=false;await u.tick();assert.equal(f.store.state.npmUpdates?.request?.phase,'failed');
});

test('registry errors are optional, unmanaged runs do not poll, durable state failure propagates',async t=>{
  const f=await fixture(t);
  const bad=new TelegramUpdates(f.store,f.bot,f.runtime,'w',f.abort.signal,async()=>{throw Error('registry offline');});await bad.tick();assert.equal(f.bot.messages.length,0);
  f.runtime.snapshot=async()=>undefined;await f.make().tick();await f.make().checkManually(owner());assert.match(f.bot.messages[0].text,/npm-пакета/);
  f.runtime.snapshot=async()=>f.snapshot;f.store.state.npmUpdates={};f.store.save=async()=>{throw Error('disk full');};await assert.rejects(f.make().tick(),/disk full/);
});

test('latest metadata rejects incomplete scanning, prereleases, foreign archives and malformed integrity',async()=>{
  const valid=()=>({'dist-tags':{latest:'0.2.3'},versions:{'0.2.3':{name:'@ivan-boss/hse-harness',version:'0.2.3',dist:{integrity,tarball:'https://registry.npmjs.org/@ivan-boss/hse-harness/-/hse-harness-0.2.3.tgz'}}}});
  assert.deepEqual(await latestRelease((async()=>Response.json(valid())) as typeof fetch),release());
  for(const mutate of [(x:any)=>x.versions={},(x:any)=>x['dist-tags'].latest='0.2.3-beta.1',(x:any)=>x.versions['0.2.3'].dist.tarball='https://evil.test/package.tgz',(x:any)=>x.versions['0.2.3'].dist.integrity='bad',(x:any)=>x.versions['0.2.3'].name='other']){const data=valid();mutate(data);await assert.rejects(latestRelease((async()=>Response.json(data)) as typeof fetch));}
});

test('/updates always shows running/latest versions and policy, including when already current',async t=>{
  const f=await fixture(t),u=f.make();f.setLatest(release('0.2.2'));
  await u.checkManually(owner());
  const message=f.bot.messages.at(-1);
  assert.match(message.text,/Текущая версия бота: 0.2.2/);
  assert.match(message.text,/Последняя версия в npm: 0.2.2/);
  assert.match(message.text,/Автообновление: 🔴 выключено/);
  assert.match(message.text,/актуальной версии/);
  assert.equal(message.reply_markup.inline_keyboard.flat().some((b:any)=>b.callback_data.startsWith('hse_update:')),false);
  assert.ok(Buffer.byteLength(f.automaticButton())<=64);
});

test('policy buttons require owner/private chat and current nonce; settings survive worker restart',async t=>{
  const f=await fixture(t),u=f.make();await u.checkManually(owner());const enable=f.automaticButton();
  await u.callback(owner(2,enable,2));await u.callback(owner(3,enable,1,'group'));await u.callback(owner(4,'hse_auto:on:forged'));
  assert.equal(f.counts.policyChanges,0);assert.equal(f.snapshot.automaticUpdates,false);
  await u.callback(owner(5,enable));assert.equal(f.snapshot.automaticUpdates,true);
  assert.match(f.bot.messages.at(-1).text,/Автообновление: 🟢 включено/);
  const disable=f.automaticButton();
  await u.callback(owner(6,enable));assert.equal(f.counts.policyChanges,1,'old enable button is inert');
  const resumed=await f.restart();await resumed.updates.callback(owner(7,disable));
  assert.equal(f.snapshot.automaticUpdates,false);assert.equal(f.counts.policyChanges,2);
  await resumed.updates.callback(owner(8,enable));assert.equal(f.snapshot.automaticUpdates,false);
  assert.match(resumed.bot.messages.at(-1).text,/устарела/);
});

test('npm outage preserves cached versions and does not prevent changing the automatic policy',async t=>{
  const f=await fixture(t),u=f.make();f.snapshot.installedVersion='0.2.3';await u.checkManually(owner());f.setRegistryDown();
  await u.checkManually(owner(2));
  assert.match(f.bot.messages.at(-1).text,/Текущая версия бота: 0.2.2/);
  assert.match(f.bot.messages.at(-1).text,/Установлена, но ещё не запущена: 0.2.3/);
  assert.match(f.bot.messages.at(-1).text,/последняя известная версия/);
  await u.callback(owner(3,f.automaticButton()));assert.equal(f.snapshot.automaticUpdates,true);
  assert.match(f.bot.messages.at(-1).text,/последняя известная версия/);
  assert.equal(f.counts.installs,0);
});

test('automatic mode reserves one pinned request and installs without an update button click',async t=>{
  const f=await fixture(t),u=f.make();await u.checkManually(owner());await u.callback(owner(2,f.automaticButton()));
  await Promise.all([u.tick(),u.tick()]);
  assert.equal(f.counts.grants,1);assert.equal(f.store.state.npmUpdates?.request?.automatic,true);
  assert.equal(f.store.state.npmUpdates?.request?.version,'0.2.3');
  f.setLatest(release('0.2.4'));await u.tick();await u.tick();
  assert.equal(f.counts.installs,1);assert.equal(f.snapshot.installedVersion,'0.2.3');
  f.snapshot.runningVersion='0.2.3';await u.tick();assert.equal(f.store.state.npmUpdates?.request?.phase,'completed');
});

test('disabling automatic mode cancels an accepted automatic request before installation',async t=>{
  const f=await fixture(t),u=f.make();f.snapshot.automaticUpdates=true;
  await u.tick();assert.equal(f.store.state.npmUpdates?.request?.phase,'pending');
  await u.checkManually(owner());await u.callback(owner(2,f.automaticButton()));await u.tick();
  assert.equal(f.snapshot.automaticUpdates,false);assert.equal(f.counts.installs,0);
  assert.equal(f.store.state.npmUpdates?.request?.phase,'failed');
  await u.tick();assert.equal(f.counts.installs,0);
  assert.equal(f.store.state.npmUpdates?.request?.cancelled,true);
  await u.callback(owner(3,f.automaticButton()));await u.tick();await u.tick();
  assert.equal(f.counts.installs,1,'explicit re-enable can retry an unstarted cancelled request');
});

test('manual approval still installs with automatic mode disabled',async t=>{
  const f=await fixture(t),u=f.make();await u.checkManually(owner());
  await u.callback(owner(2,f.button()));await u.tick();
  assert.equal(f.snapshot.automaticUpdates,false);assert.equal(f.counts.installs,1);
  assert.equal(f.store.state.npmUpdates?.request?.automatic,false);
});

test('a formerly managed settings button cannot change policy in an unmanaged worker',async t=>{
  const f=await fixture(t),u=f.make();await u.checkManually(owner());const enable=f.automaticButton();
  f.runtime.snapshot=async()=>undefined;await u.callback(owner(2,enable));
  assert.equal(f.counts.policyChanges,0);assert.match(f.bot.messages.at(-1).text,/npm-пакета/);
});

test('automatic failures do not create install loops; daily reminders continue and a new release can be tried',async t=>{
  const f=await fixture(t),u=f.make();f.snapshot.automaticUpdates=true;let attempts=0;
  f.runtime.install=async()=>{attempts++;throw Error('installer offline');};
  await u.tick();await u.tick();assert.equal(attempts,1);
  await u.tick();await u.tick();assert.equal(attempts,1);
  const before=f.bot.messages.length;f.setTime(24*3600_000);await u.tick();
  assert.equal(f.bot.messages.length,before+1);assert.match(f.bot.messages.at(-1).text,/Нажми «Обновить»/);
  assert.equal(attempts,1);
  const resumed=await f.restart();await resumed.updates.tick();assert.equal(attempts,1);
  f.setTime(3600_000);f.setLatest(release('0.2.4'));await resumed.updates.tick();await resumed.updates.tick();
  assert.equal(attempts,2);
});

test('quarantined versions and an unsettled running release are not installed automatically',async t=>{
  const f=await fixture(t),u=f.make();f.snapshot.automaticUpdates=true;f.snapshot.quarantined=['0.2.3'];
  await u.tick();assert.equal(f.counts.grants,0);
  f.snapshot.quarantined=[];f.snapshot.stable=false;await u.tick();assert.equal(f.counts.grants,0);
  f.snapshot.stable=true;await u.tick();assert.equal(f.counts.grants,1);
});

test('disabling policy while registry lookup is in flight prevents a later automatic request',async t=>{
  const f=await fixture(t);f.snapshot.automaticUpdates=true;f.runtime.snapshot=async()=>({...f.snapshot});
  let arrived!:()=>void,releaseLookup!:()=>void;
  const started=new Promise<void>(r=>{arrived=r;}),gate=new Promise<void>(r=>{releaseLookup=r;});
  const u=new TelegramUpdates(f.store,f.bot,f.runtime,'w',f.abort.signal,async()=>{arrived();await gate;return release();});
  const tick=u.tick();await started;await f.runtime.setAutomatic(false);releaseLookup();await tick;
  assert.equal(f.store.state.npmUpdates?.request,undefined);assert.equal(f.counts.installs,0);
});

test('daily reminder cooldown survives manual checks and stops when the running version catches up',async t=>{
  const f=await fixture(t),u=f.make();await u.tick();f.setTime(23*3600_000);await u.checkManually(owner());
  const before=f.bot.messages.length;f.setTime(3600_000);await u.tick();assert.equal(f.bot.messages.length,before+1);
  f.snapshot.runningVersion='0.2.3';f.setTime(24*3600_000);await u.tick();assert.equal(f.bot.messages.length,before+1);
});
