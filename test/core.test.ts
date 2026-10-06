import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deadline, reminderJobs, type Task } from '../src/domain.js';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { Approvals } from '../src/approvals.js';
import { TelegramBot } from '../src/bot.js';
import { textPart } from '../src/mail.js';
import { hseUrl } from '../src/tools.js';

const task=(overrides:Partial<Task>={}):Task=>({id:'hw1',title:'ДЗ1',course:'Тестирование',status:'open',deadline:'2026-10-20T12:00:00.000Z',deadlineBasis:'explicit',sources:['tg:-100123:42'],notes:'',disputed:false,...overrides});
async function fixture(fn:(store:Store,messages:string[])=>Promise<void>):Promise<void> {
  const dir=await mkdtemp(join(tmpdir(),'study-test-'));const store=new Store(dir);await store.load();
  try{await fn(store,[]);}finally{await rm(dir,{recursive:true,force:true});}
}

test('дата без часа означает начало указанного дня по Москве, а не конец',()=>{
  assert.deepEqual(deadline('2026-10-09'),{value:'2026-10-08T21:00:00.000Z',basis:'personal-date-rule'});
  assert.equal(deadline('2026-10-09T18:00:00+03:00').value,'2026-10-09T15:00:00.000Z');
  assert.throws(()=>deadline('2026-02-30'));assert.throws(()=>deadline('2026-10-09T18:00:00'));
});
test('сделал продолжает напоминания, сдал и отмена прекращают; статус не повторяет доставленные интервалы',()=>{
  assert.equal(reminderJobs(task()).length,3);assert.equal(reminderJobs(task({status:'done'})).length,3);
  assert.deepEqual(reminderJobs(task()).map(x=>x.id),reminderJobs(task({status:'done'})).map(x=>x.id));
  assert.equal(reminderJobs(task({status:'submitted'})).length,0);assert.equal(reminderJobs(task({status:'cancelled'})).length,0);
  assert.equal(reminderJobs(task({deadline:undefined})).length,0);
  assert.equal(+new Date(task().deadline!)-reminderJobs(task())[2]!.due,3600_000);
});
test('после простоя отправляется одно актуальное напоминание; после рестарта не повторяется',()=>fixture(async(store,messages)=>{
  const bot={send:async(s:string)=>{messages.push(s);}};const scheduler=new Scheduler(store,bot);
  await scheduler.sync([task()]);const now=Date.parse(task().deadline!)-30*60_000;
  await scheduler.tick(now);assert.equal(messages.length,1);assert.match(messages[0]!,/задержкой/);
  const restarted=new Store(store.dir);await restarted.load();await new Scheduler(restarted,bot).tick(now+1000);assert.equal(messages.length,1);
}));
test('перенос отменяет старые таймеры, а отмена/сдача снимают оставшиеся',()=>fixture(async(store,messages)=>{
  const scheduler=new Scheduler(store,{send:async(s:string)=>{messages.push(s);}});
  await scheduler.sync([task()]);await scheduler.sync([task({deadline:'2026-11-01T12:00:00.000Z'})]);
  await scheduler.tick(Date.parse('2026-10-20T12:00:00Z'));assert.equal(messages.length,0);
  await scheduler.sync([task({status:'submitted'})]);assert.equal(store.state.jobs.length,0);
  await scheduler.sync([task({status:'cancelled'})]);assert.equal(store.state.jobs.length,0);
}));
test('сбой доставки не отмечается успехом, повтор после восстановления возможен',()=>fixture(async(store,messages)=>{
  let fail=true;const scheduler=new Scheduler(store,{send:async(s:string)=>{if(fail)throw new Error('offline');messages.push(s);}});
  await scheduler.sync([task()]);const now=Date.parse(task().deadline!)-3600_000;
  await assert.rejects(()=>scheduler.tick(now));assert.equal(Object.keys(store.state.delivered).length,0);
  fail=false;await scheduler.tick(now);assert.equal(messages.length,1);
}));
test('срочный перенос сохраняется до доставки и восстанавливается после рестарта, даже если календарь уже изменен',()=>fixture(async(store,messages)=>{
  const s=new Scheduler(store,{send:async()=>{throw new Error('offline');}});
  const moved=task({deadline:'2026-10-22T12:00:00Z'});
  await assert.rejects(()=>s.urgent(moved,task(),1000));assert.equal(Object.keys(store.state.notices).length,1);
  const recovered=new Store(store.dir);await recovered.load();
  await new Scheduler(recovered,{send:async(text:string)=>{messages.push(text);}}).tick(2000);
  assert.equal(messages.length,1);assert.match(messages[0]!,/22 окт/);assert.equal(Object.keys(recovered.state.notices).length,0);
}));
test('несколько переносов при недоступном боте восстанавливают только актуальное срочное уведомление',()=>fixture(async(store,messages)=>{
  const offline=new Scheduler(store,{send:async()=>{throw new Error('offline');}});
  const first=task({deadline:'2026-10-22T12:00:00Z'}),latest=task({deadline:'2026-10-24T12:00:00Z'});
  await assert.rejects(()=>offline.urgent(first,task(),1000));
  await assert.rejects(()=>offline.urgent(latest,first,2000));
  const recovered=new Store(store.dir);await recovered.load();
  await new Scheduler(recovered,{send:async(text:string)=>{messages.push(text);}}).tick(3000);
  assert.equal(messages.length,1);assert.match(messages[0]!,/24 окт/);assert.doesNotMatch(messages[0]!,/22 окт/);
}));
test('утренние/вечерние сводки считаются по Москве и не дублируются в очереди',()=>fixture(async(store)=>{
  const s=new Scheduler(store,{send:async()=>{}});
  await s.digests(Date.parse('2026-10-09T07:05:00Z'));await s.digests(Date.parse('2026-10-09T07:06:00Z'));
  await s.digests(Date.parse('2026-10-09T17:01:00Z'));assert.deepEqual(store.state.queue.map(x=>x.digest),['morning','evening']);
}));
test('очередь устойчива: дубликаты отсекаются, правка сохраняется до продвижения курсора',()=>fixture(async(store)=>{
  const source={id:'tg:-1001:1',kind:'telegram' as const,text:'ДЗ до 9 октября',date:'2026-10-01T00:00:00Z'};
  await store.enqueue([source]);await store.enqueue([source]);assert.equal(store.state.queue.length,1);
  await store.enqueue([{...source,text:'Перенос до 10 октября'}]);assert.equal(store.state.queue.length,2);
  const recovered=new Store(store.dir);await recovered.load();assert.equal(recovered.state.queue.length,2);
  assert.equal(recovered.state.seen[source.id]!.length,64);assert.ok(!recovered.state.seen[source.id]!.includes('ДЗ'));
}));
test('длинное текстовое письмо не усекается: все части попадают в bounded очередь с одним исходным id',()=>fixture(async(store)=>{
  const text='Начало\n'+'а'.repeat(25_000)+'\nСрок в самом конце: 9 октября';
  await store.enqueue([{id:'mail:one',kind:'mail',text,date:'2026-10-01T00:00:00Z'}]);
  assert.ok(store.state.queue.length>1);assert.ok(store.state.queue.every(x=>x.sources.length<=4));
  const parts=store.state.queue.flatMap(x=>x.sources);assert.ok(parts.every(x=>x.id==='mail:one'));assert.match(parts.at(-1)!.text,/Срок в самом конце: 9 октября/);
}));
test('подтверждение одноразовое, только конкретный неизменяемый текст/чат; повтор черновика не спамит',()=>fixture(async(store,messages)=>{
  const sends:{chat:string;text:string;randomId:string}[]=[];
  const a=new Approvals(store,{send:async(s:string)=>{messages.push(s);}},{question:async(chat,text,randomId)=>{sends.push({chat,text,randomId});return '77';},lesson:async()=>{}},new Set(['-1001']));
  const payload={chat:'-1001',text:'Когда сдавать ДЗ?'};const id=await a.propose('question',payload,1000);
  payload.text='Измененный текст';assert.equal(sends.length,0);
  assert.equal(await a.propose('question',{chat:'-1001',text:'Когда сдавать ДЗ?'},2000),id);assert.equal(messages.length,1);
  await a.decide(id,true,3000);await a.decide(id,true,4000);assert.equal(sends.length,1);assert.equal(sends[0]!.text,'Когда сдавать ДЗ?');
  await assert.rejects(()=>a.propose('question',{chat:'-1002',text:'Вопрос'},4000));
}));
test('неоднозначная отправка и рестарт повторяют тот же random_id',()=>fixture(async(store)=>{
  const ids:string[]=[];let fail=true;
  const sender={question:async(_chat:string,_text:string,id:string)=>{ids.push(id);if(fail)throw new Error('timeout');return '77';},lesson:async()=>{}};
  const approvals=new Approvals(store,{send:async()=>{}},sender,new Set(['-1001']));
  const id=await approvals.propose('question',{chat:'-1001',text:'Срок?'},Date.now());await assert.rejects(()=>approvals.decide(id,true));
  const restart=new Store(store.dir);await restart.load();fail=false;await new Approvals(restart,{send:async()=>{}},sender,new Set(['-1001'])).recover();
  assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);assert.equal(restart.state.approvals[0]!.state,'sent');
}));
test('через сутки без ответа уведомляем один раз; ответ в другом чате не считается',()=>fixture(async(store,messages)=>{
  const a=new Approvals(store,{send:async(s:string)=>{messages.push(s);}},{question:async()=> '77',lesson:async()=>{}},new Set(['-1001']));
  const id=await a.propose('question',{chat:'-1001',text:'Срок?'},1000);await a.decide(id,true,2000);
  await a.reply('-1002','77');await a.tick(2000+86400_000);await a.tick(2000+86400_001);assert.equal(messages.length,2);
}));
test('сообщения/подтверждения из группы или от постороннего не принимаются',()=>{
  const bot=new TelegramBot(123);
  assert.equal(bot.isOwner({update_id:1,message:{message_id:1,from:{id:123},chat:{id:-1001,type:'supergroup'},text:'ок'}}),false);
  assert.equal(bot.isOwner({update_id:1,callback_query:{id:'1',from:{id:456},message:{chat:{id:123,type:'private'}},data:'approve:x'}}),false);
  assert.equal(bot.isOwner({update_id:1,message:{message_id:1,from:{id:123},chat:{id:123,type:'private'},text:'сдал'}}),true);
});
test('почтовые вложения/rfc822 не анализируются, основной текст выбирается среди MIME alternatives',()=>{
  assert.equal(textPart({type:'multipart/mixed',childNodes:[{type:'message/rfc822',childNodes:[{type:'text/plain',part:'1.1'}]},{type:'text/plain',part:'2',disposition:'attachment'},{type:'text/html',part:'3'}]})?.part,'3');
  assert.equal(textPart({type:'multipart/alternative',childNodes:[{type:'text/html',part:'1'},{type:'text/plain',part:'2'}]})?.part,'2');
});
test('веб-инструмент ограничен официальными HTTPS источниками',()=>{
  assert.equal(hseUrl('https://www.hse.ru/ba/se/').hostname,'www.hse.ru');
  for(const u of ['http://www.hse.ru','https://hse.ru.evil.com','https://evil.com','https://token@hse.ru','https://hse.ru:8080'])assert.throws(()=>hseUrl(u));
});
