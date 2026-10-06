import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Api } from 'teleproto';
import bigInt from 'big-integer';
import { Google } from '../src/google.js';
import { GoogleCollection } from '../src/calendar/providers/google.js';
import { StudyCalendar } from '../src/calendar/study-calendar.js';
import { Store } from '../src/store.js';
import { TelegramSource } from '../src/telegram.js';
import { studyTools } from '../src/tools.js';
import { Scheduler } from '../src/scheduler.js';
import { PiAssistant } from '../src/pi.js';
import type { Task } from '../src/domain.js';
import type { Config } from '../src/config.js';
import type { Approvals } from '../src/approvals.js';

const config:Config={ownerId:1,chats:[{id:'-100123',title:'Учеба'}],features:{googleCalendar:true,icloudCalendar:true},calendars:{timetable:{provider:'google',id:'schedule'},agent:{provider:'google',id:'agent'}},folders:[],model:'unused',pollSeconds:60};
const t:Task={id:'hw1',title:'Тестовая работа',course:'Тестирование',status:'open',deadline:'2026-10-09T12:00:00Z',deadlineBasis:'explicit',notes:'а'.repeat(2000),sources:['tg:-100123:42'],disputed:false};
async function withStore(fn:(store:Store)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'study-wire-'));const store=new Store(dir);await store.load();try{await fn(store);}finally{await rm(dir,{recursive:true,force:true});}}

test('Google Calendar: длинное описание, стабильный event id, перенос и отмена не затрагивают расписание',async()=>{
  const events=new Map<string,any>();const calls:{path:string;method:string}[]=[];
  class Wire extends Google {override async request<T>(path:string,method='GET',body?:any):Promise<T>{
    calls.push({path,method});assert.ok(path.startsWith('calendars/agent/events'));
    const id=path.split('/')[3]?.split('?')[0];
    if(method==='GET')return {items:[...events.values()]} as T;
    if(method==='PUT'&&!events.has(id!))throw Object.assign(new Error('missing'),{status:404});
    if(method==='DELETE'){events.delete(id!);return undefined as T;}
    const key=id??body.id;events.set(key,structuredClone(body));return body;
  }}
  const api=new Wire(),calendar=new StudyCalendar(new GoogleCollection(api,'schedule'),new GoogleCollection(api,'agent'));await calendar.putTask(t);
  assert.equal(events.size,1);assert.equal((await calendar.listTasks())[0]?.notes,t.notes);
  for(const value of Object.values([...events.values()][0].extendedProperties.private))assert.ok(Buffer.byteLength(String(value))<=1024);
  await calendar.putTask({...t,deadline:'2026-10-12T12:00:00Z'});assert.equal(events.size,1);
  assert.equal((await calendar.listTasks())[0]?.deadline,'2026-10-12T12:00:00.000Z');
  await calendar.putTask({...t,status:'cancelled'});assert.equal(events.size,0);
  assert.throws(()=>new StudyCalendar(new GoogleCollection(api,'same'),new GoogleCollection(api,'same')));
});
test('Google syncToken: 410 ведет к полной синхронизации без запрещенных timeMin/timeMax фильтров',()=>withStore(async store=>{
  store.state.calendarTokens['google:schedule']='expired';let requests=0;
  class Wire extends Google {override async request<T>(path:string):Promise<T>{
    const url=new URL('https://example.test/'+path);assert.equal(url.searchParams.has('timeMin'),false);assert.equal(url.searchParams.has('timeMax'),false);
    requests++;if(requests===1){assert.equal(url.searchParams.get('syncToken'),'expired');throw Object.assign(new Error('expired'),{status:410});}
    assert.equal(url.searchParams.has('syncToken'),false);
    return {items:[{id:'lesson1',summary:'Семинар',start:{dateTime:'2026-10-09T10:00:00+03:00'}}],nextSyncToken:'fresh'} as T;
  }}
  const api=new Wire();await new StudyCalendar(new GoogleCollection(api,'schedule'),new GoogleCollection(api,'agent')).syncSchedule(store);
  assert.equal(store.state.calendarTokens['google:schedule'],'fresh');assert.equal(store.state.queue[0]?.sources[0]?.id,'calendar:google:schedule:lesson1');
}));
test('Telegram после рестарта восстанавливает правку/удаление из channel difference и сохраняет pts после очереди',()=>withStore(async store=>{
  store.state.cursors.tgState=JSON.stringify({pts:1,qts:0,date:1,seq:1});store.state.cursors['tgChannel:-100123']='5';store.state.cursors['tgHistory:-100123']='1';
  await store.enqueue([{id:'tg:-100123:41',kind:'telegram',text:'старый срок',date:'2026-10-01T00:00:00Z'}]);store.state.queue=[];
  const message=new Api.Message({id:42,peerId:new Api.PeerChannel({channelId:bigInt(123)}),date:1790812800,message:'Перенос ДЗ на 12 октября'});
  const wire={invoke:async(request:unknown)=>{
    if(request instanceof Api.updates.GetDifference)return new Api.updates.DifferenceEmpty({date:2,seq:2});
    assert.ok(request instanceof Api.updates.GetChannelDifference);assert.equal(request.pts,5);
    return new Api.updates.ChannelDifference({final:true,pts:8,newMessages:[],otherUpdates:[new Api.UpdateEditChannelMessage({message,pts:7,ptsCount:1}),new Api.UpdateDeleteChannelMessages({channelId:bigInt(123),messages:[41],pts:8,ptsCount:1})],users:[],chats:[]});
  }};
  const source=new TelegramSource(config,store,async()=>{},async()=>{});
  Object.assign(source,{client:wire,peers:new Map([['-100123',new Api.InputPeerChannel({channelId:bigInt(123),accessHash:bigInt(1)})]])});
  await source.poll();assert.equal(store.state.cursors['tgChannel:-100123'],'8');
  const all=store.state.queue.flatMap(x=>x.sources);assert.match(all.find(x=>x.id.endsWith(':42'))!.text,/12 октября/);assert.equal(all.find(x=>x.id.endsWith(':41'))?.deleted,true);
  const restored=new Store(store.dir);await restored.load();assert.equal(restored.state.cursors['tgChannel:-100123'],'8');assert.equal(restored.state.queue.length,2);
}));
test('инструмент не принимает «сдал» из учебного источника, но принимает сообщение владельца',()=>withStore(async store=>{
  let current:Task={...t,notes:''};const calendar={listTasks:async()=>[current],putTask:async(value:Task)=>{current=value;},lessons:async()=>[],changeLesson:async()=>{}};
  const pi=new PiAssistant();const bot={send:async()=>{}};
  const tools=studyTools({calendar,pi,bot,store,scheduler:new Scheduler(store,bot),approvals:{} as Approvals,telegram:{} as TelegramSource});
  const update=tools.find(t=>t.name==='update_task')!;
  const args={id:t.id,title:t.title,course:t.course,status:'submitted',deadlines:[t.deadline!],basis:'explicit',sources:t.sources,notes:'',disputed:false};
  await assert.rejects(()=>update.execute('1',args,undefined,undefined,{} as never),/только владелец/);assert.equal(current.status,'open');
  pi.ownerTurn=true;await update.execute('2',args,undefined,undefined,{} as never);assert.equal(current.status,'submitted');assert.equal(store.state.jobs.length,0);
  pi.ownerTurn=false;await update.execute('3',{...args,status:'open',deadlines:['2026-10-12T12:00:00Z']},undefined,undefined,{} as never);
  assert.equal(current.status,'submitted');assert.equal(current.deadline,'2026-10-12T12:00:00.000Z');assert.equal(store.state.jobs.length,0);
}));
