import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Api, TelegramClient } from 'teleproto';
import { getPeerId } from 'teleproto/Utils.js';
import bigInt from 'big-integer';
import { parseTelegramChatReference, resolveTelegramChat } from '../src/telegram-chats.js';
import { TelegramSource } from '../src/telegram.js';
import { Store } from '../src/store.js';
import { saveTelegramChat, withConfigWriteLock } from '../src/config-file.js';
import { SetupState, normalizeSetupConfig } from '../src/cli/state.js';
import { showTelegramAccess } from '../src/cli/telegram-access.js';
import { studyTools } from '../src/tools.js';
import type { Config } from '../src/config.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { PiAssistant } from '../src/pi.js';

const channel=(id=1234,extra={})=>new Api.Channel({id:bigInt(id),accessHash:bigInt(42),title:'ВШЭ · Тестирование',username:'hsetestingseminar',photo:new Api.ChatPhotoEmpty(),date:1791000000,megagroup:true,...extra});
const group=(id=4321,extra={})=>new Api.Chat({id:bigInt(id),title:'БПИ243',photo:new Api.ChatPhotoEmpty(),participantsCount:20,date:1791000000,version:1,...extra});
const canonical=getPeerId(channel());
class Transport {
  entities: (Api.Chat|Api.Channel|Api.User|Api.ChatForbidden)[]=[channel(),group()];
  resolved: Api.TypeChat|Api.User=channel();
  invitation: Api.TypeChatInvite=new Api.ChatInviteAlready({chat:channel()});
  requests:string[]=[];reads=0;historyReads=0;readDown=false;
  duringDifference?:()=>Promise<void>;
  updateManager={stop(){}};
  async connect(){} async disconnect(){} async checkAuthorization(){return true;}
  async getDialogs(){return this.entities.map(entity=>({id:bigInt(getPeerId(entity)),entity}));}
  async getEntity(){return this.resolved;}
  async getInputEntity(entity:Api.Chat|Api.Channel){return entity instanceof Api.Channel?new Api.InputPeerChannel({channelId:entity.id,accessHash:entity.accessHash!}):new Api.InputPeerChat({chatId:entity.id});}
  async getMessages(){this.reads++;if(this.readDown)throw Error('Private SDK error with credentials');return [];}
  async *iterMessages(peer:Api.TypeInputPeer){
    this.historyReads++;
    const peerId=peer instanceof Api.InputPeerChannel?new Api.PeerChannel({channelId:peer.channelId}):new Api.PeerChat({chatId:(peer as Api.InputPeerChat).chatId});
    for(const [id,date,text] of [[3,'2026-10-12T12:00:00Z','ДЗ до 20 октября'],[2,'2026-09-01T00:00:00+03:00','ДЗ с начала семестра'],[1,'2026-08-31T20:59:59Z','Старый семестр']] as const)yield new Api.Message({id,date:Date.parse(date)/1000,message:text,peerId});
  }
  async invoke(request:any){
    this.requests.push(request.className);
    if(request instanceof Api.messages.CheckChatInvite)return this.invitation;
    if(request instanceof Api.updates.GetState)return new Api.updates.State({pts:1,qts:0,date:1791800000,seq:1,unreadCount:0});
    if(request instanceof Api.channels.GetFullChannel)return {fullChat:new Api.ChannelFull({id:request.channel.channelId,pts:10,about:''} as any)};
    if(request instanceof Api.updates.GetDifference){await this.duringDifference?.();return new Api.updates.DifferenceEmpty({date:1791800000,seq:1});}
    if(request instanceof Api.updates.GetChannelDifference){assert.equal(request.pts,10,'difference ran before initialization');return new Api.updates.ChannelDifferenceEmpty({pts:10,final:true});}
    assert.fail('Unexpected Telegram mutation: '+request.className);
  }
  get client(){return this as unknown as TelegramClient;}
}

test('Telegram references normalize IDs, usernames, message URLs, private links and invite forms',()=>{
  for(const reference of [canonical,'https://t.me/c/1234/9','https://t.me/c/1234/8/9'])assert.deepEqual(parseTelegramChatReference(reference),{kind:'id',value:canonical});
  for(const reference of ['@HseTestingSeminar','hsetestingseminar','https://t.me/hsetestingseminar/10?single','https://t.me/s/hsetestingseminar/10','telegram.me/hsetestingseminar','tg://resolve?domain=hsetestingseminar'])assert.deepEqual(parseTelegramChatReference(reference),{kind:'username',value:'hsetestingseminar'});
  for(const reference of ['https://t.me/+invite_test','https://t.me/joinchat/invite_test','tg://join?invite=invite_test'])assert.deepEqual(parseTelegramChatReference(reference),{kind:'invite',value:'invite_test'});
  for(const reference of ['0','https://example.com/hsetestingseminar','https://t.me.evil.test/chat','https://secret@t.me/chat','https://t.me:8443/chat','https://t.me/c/0/9','https://t.me/share/url','tg://proxy?server=x','x'.repeat(501)])assert.throws(()=>parseTelegramChatReference(reference));
});

test('resolution returns canonical channel/group IDs and checks read access without joining',async()=>{
  const wire=new Transport();
  for(const reference of [canonical,'1234','https://t.me/c/1234/9','@hsetestingseminar','https://t.me/+invite_test']) {
    const result=await resolveTelegramChat(wire.client,reference);
    assert.deepEqual(result.chat,{id:canonical,title:'ВШЭ · Тестирование',allowQuestions:false});
  }
  assert.equal((await resolveTelegramChat(wire.client,'-4321')).chat.id,'-4321');
  assert.equal(wire.reads,6);
  assert.deepEqual(wire.requests,['messages.CheckChatInvite']);
});

test('public but unjoined channels, left/forbidden chats, users and invite previews are rejected',async()=>{
  const wire=new Transport();
  for(const entity of [channel(1234,{left:true}),new Api.ChatForbidden({id:bigInt(1234),title:'Hidden'}),new Api.User({id:bigInt(1234)})]) {
    wire.entities=[entity];await assert.rejects(resolveTelegramChat(wire.client,canonical),/Нет доступа/);
  }
  wire.entities=[];await assert.rejects(resolveTelegramChat(wire.client,'@hsetestingseminar'),/Нет доступа/);
  wire.resolved=new Api.User({id:bigInt(1234)});await assert.rejects(resolveTelegramChat(wire.client,'@hsetestingseminar'),/личным диалогом/);
  wire.invitation=new Api.ChatInvitePeek({chat:channel(),expires:1792000000});await assert.rejects(resolveTelegramChat(wire.client,'https://t.me/+preview'),/Нет доступа/);
  assert.equal(wire.reads,0);assert.ok(wire.requests.every(name=>name==='messages.CheckChatInvite'));
});

test('raw IDs must be unambiguous and read errors do not disclose transport details',async()=>{
  const wire=new Transport();wire.entities=[channel(),group(1234)];
  await assert.rejects(resolveTelegramChat(wire.client,'1234'),/Неоднозначный/);
  wire.readDown=true;await assert.rejects(resolveTelegramChat(wire.client,canonical),error=>{assert.match((error as Error).message,/прочитать чат/);assert.doesNotMatch((error as Error).message,/Private|credentials/);return true;});
});

async function fixture(run:(source:TelegramSource,wire:Transport,store:Store,path:string,config:Config)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),'hse-dynamic-chat-')),path=join(root,'config.json');
  const old=process.env.STUDY_SECRETS_DIR;process.env.STUDY_SECRETS_DIR=join(root,'secrets');
  const config=normalizeSetupConfig({ownerId:42,chats:[],model:'test',extraSetting:{keep:true}});
  await mkdir(join(root,'secrets'));await writeFile(join(root,'secrets/telegram.session'),'fixture');await writeFile(path,JSON.stringify(config));
  const wire=new Transport(),store=new Store(join(root,'data'));await store.load();
  const source=new TelegramSource(config,store,async()=>{},async()=>{},()=>true,{configPath:path,createClient:()=>wire.client});
  try {await source.connect();await run(source,wire,store,path,config);}
  finally{await source.close();old===undefined?delete process.env.STUDY_SECRETS_DIR:process.env.STUDY_SECRETS_DIR=old;await rm(root,{recursive:true,force:true});}
}

test('agent tool adds a live source, backfills from semester start, deduplicates and survives reconnect',()=>fixture(async(source,wire,store,path,config)=>{
  const tools=studyTools({telegram:source} as Parameters<typeof studyTools>[0]);
  const add=tools.find(t=>t.name==='add_telegram_chat')!,list=tools.find(t=>t.name==='list_telegram_chats')!;
  const result=await add.execute('call1',{reference:'https://t.me/hsetestingseminar'});
  assert.equal(JSON.parse((result.content[0] as {text:string}).text).backfillPending,true);assert.equal(source.listChats()[0]?.connected,true);
  assert.equal(wire.historyReads,0,'add must not block an agent turn on the full history');
  await source.poll();
  assert.equal(store.state.cursors[`tgHistory:${canonical}`],'1');
  assert.equal(store.state.queue.flatMap(x=>x.sources).length,2,'August history must be excluded; September boundary included');
  assert.equal(JSON.parse(((await list.execute('call2',{})).content[0] as {text:string}).text)[0].historyLoaded,true);
  assert.equal((await source.addChat(canonical)).alreadyAdded,true);await source.poll();
  assert.equal(config.chats.length,1);assert.equal(store.state.queue.flatMap(x=>x.sources).length,2);assert.equal(wire.historyReads,1);
  const saved=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(saved.extraSetting,{keep:true});assert.equal(saved.chats[0].allowQuestions,false);assert.equal((await stat(path)).mode&0o777,0o600);
  assert.doesNotMatch(JSON.stringify(saved),/invite_test|accessHash/);
  const reopened=new Store(store.dir);await reopened.load();
  const resumed=new TelegramSource(saved,reopened,async()=>{},async()=>{},()=>true,{configPath:path,createClient:()=>wire.client});
  await resumed.connect();await resumed.poll();await resumed.close();assert.equal(wire.historyReads,1);assert.equal(resumed.listChats()[0]?.historyLoaded,true);
  await assert.rejects(source.question(canonical,'Привет','1'),/только для чтения/);
  assert.ok(!wire.requests.includes('messages.SendMessage'));
}));

test('chat added during polling waits until next cycle before channel difference',()=>fixture(async(source,wire,store)=>{
  wire.duringDifference=async()=>{wire.duringDifference=undefined;await source.addChat(canonical);};
  await source.poll();assert.equal(wire.historyReads,0);assert.equal(store.state.cursors[`tgChannel:${canonical}`],undefined);
  await source.poll();assert.equal(wire.historyReads,1);assert.equal(store.state.cursors[`tgChannel:${canonical}`],'10');
}));

test('inaccessible chat and failed durable save never activate or enqueue a source',()=>fixture(async(source,wire,store,path,config)=>{
  wire.readDown=true;await assert.rejects(source.addChat(canonical),/прочитать чат/);assert.equal(config.chats.length,0);
  wire.readDown=false;await writeFile(path,JSON.stringify({...config,ownerId:99}));
  await assert.rejects(source.addChat(canonical),/Владелец/);assert.deepEqual(source.listChats(),[]);
  await source.poll();assert.equal(wire.historyReads,0);assert.equal(store.state.queue.length,0);
}));

test('config additions serialize and stale CLI cannot overwrite a dynamically added chat',()=>fixture(async(_source,_wire,_store,path,config)=>{
  const cli=new SetupState(join(path,'..'),path+'.env',path);await cli.load();
  await Promise.all([saveTelegramChat(path,{id:canonical,title:'A',allowQuestions:false},42),saveTelegramChat(path,{id:'-4321',title:'B',allowQuestions:false},42),saveTelegramChat(path,{id:canonical,title:'Duplicate'},42)]);
  const saved=JSON.parse(await readFile(path,'utf8'));assert.equal(saved.chats.length,2);assert.equal(saved.chats.find((c:any)=>c.id===canonical).allowQuestions,false);
  cli.config.model='stale';await assert.rejects(cli.save(),/другом окне/);assert.equal(JSON.parse(await readFile(path,'utf8')).model,config.model);
}));

test('config lock serializes CLI edits before a source merge, preserving unrelated fields',()=>fixture(async(_source,_wire,_store,path)=>{
  const cli=new SetupState(join(path,'..'),path+'.env',path);await cli.load();
  cli.config.model='edited-in-cli';
  await Promise.all([cli.save(),saveTelegramChat(path,{id:canonical,title:'A',allowQuestions:false},42)]);
  const saved=JSON.parse(await readFile(path,'utf8'));assert.equal(saved.model,'edited-in-cli');assert.equal(saved.chats.length,1);
  await assert.rejects(withConfigWriteLock(path,async()=>{throw Error('fixture failure');}),/fixture failure/);
  await withConfigWriteLock(path,async()=>{});
}));

test('CLI displays read-only source permissions distinctly and validates them',()=>{
  const notes:string[]=[];showTelegramAccess({ownerId:42,chats:[{id:'-1',title:'Old'},{id:'-2',title:'New',allowQuestions:false}]},{note:message=>notes.push(message)});
  assert.match(notes.join('\n'),/Old[\s\S]*Вопрос после подтверждения/);assert.match(notes.join('\n'),/New[\s\S]*Только чтение/);
  assert.throws(()=>normalizeSetupConfig({chats:[{id:'-1',title:'Bad',allowQuestions:'yes'}]}));
});

test('real Pi agent calls source tools, receives canonical ID and sees backfilled messages in its native session',()=>fixture(async(source,_wire,store)=>{
  const originalCreate=ModelRuntime.create,oldData=process.env.STUDY_DATA_DIR;
  process.env.STUDY_DATA_DIR=store.dir;
  const pi=new PiAssistant();let turns=0;
  ModelRuntime.create=async options=>{
    const runtime=await originalCreate({...options,allowModelNetwork:false,refreshOnCreate:false});
    const model=runtime.getModels('openai')[0]!;
    runtime.getModel=()=>model;runtime.isUsingSubscription=()=>true;runtime.hasConfiguredAuth=()=>true;
    runtime.getAuth=async()=>({auth:{apiKey:'fixture'}} as any);runtime.checkAuth=async()=>({apiKey:'fixture'} as any);
    runtime.streamSimple=(_model,context)=>{
      const stream=new AssistantMessageEventStream();
      const last=context.messages.at(-1)!;
      const response:any={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',content:[]};
      if(last.role==='user'&&turns++===0){response.content=[{type:'toolCall',id:'source-call',name:'add_telegram_chat',arguments:{reference:'https://t.me/hsetestingseminar'}}];response.stopReason='toolUse';}
      else if(last.role==='toolResult'){
        assert.equal(last.toolName,'add_telegram_chat');assert.equal(last.isError,false);
        const result=JSON.parse((last.content[0] as {text:string}).text);assert.equal(result.id,canonical);assert.equal(result.backfillPending,true);
        response.content=[{type:'text',text:'Чат подключён. История ожидает загрузки.'}];
      }else response.content=[{type:'text',text:'Получены учебные сообщения.'}];
      queueMicrotask(()=>{stream.push({type:'start',partial:response});stream.push({type:'done',reason:response.stopReason,message:response});});
      return stream;
    };
    return runtime;
  };
  try {
    await pi.open(store,'fixture',studyTools({telegram:source} as Parameters<typeof studyTools>[0]));
    pi.turnId='owner-connect';assert.match(await pi.prompt('Добавь учебный чат https://t.me/hsetestingseminar',true),/Чат подключён/);
    await source.poll();const messages=store.state.queue.flatMap(x=>x.sources);
    pi.turnId='source-history';assert.match(await pi.prompt('Новые ДАННЫЕ:\n'+JSON.stringify(messages)),/Получены/);
    assert.match(await readFile(store.state.sessionPath!,'utf8'),/ДЗ с начала семестра/);
    assert.match(await readFile(store.state.sessionPath!,'utf8'),/add_telegram_chat/);
  }finally{pi.dispose();ModelRuntime.create=originalCreate;oldData===undefined?delete process.env.STUDY_DATA_DIR:process.env.STUDY_DATA_DIR=oldData;}
}));
