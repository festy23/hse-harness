import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {Scheduler} from '../src/scheduler.js';
import {applyTaskOperation,recoverTaskOperations,CalendarOperationConflict} from '../src/worker/task-operations.js';
import type {Calendar,Task} from '../src/domain.js';
const before:Task={id:'hw1',title:'ДЗ 1',course:'Тестирование',status:'open',deadline:'2026-10-18T09:00:00.000Z',deadlineBasis:'explicit',sources:['tg:1'],notes:'',disputed:false};
const moved:Task={...before,deadline:'2026-10-20T09:00:00.000Z'};
class Wire implements Calendar{
  current:Task|undefined=structuredClone(before);puts=0;readDown=false;acceptedThenLost=false;
  async listTasks(){if(this.readDown)throw Error('Calendar read unavailable');return this.current?[structuredClone(this.current)]:[];}
  async putTask(task:Task){this.puts++;this.current=task.status==='cancelled'||!task.deadline?undefined:structuredClone(task);if(this.acceptedThenLost)throw Error('Accepted, then response lost');}
  async lessons(){return [];}
  async changeLesson(){}
}
async function fixture(run:(store:Store,wire:Wire,messages:string[],scheduler:Scheduler)=>Promise<void>){const folder=await mkdtemp(join(tmpdir(),'task-operations-'));const store=new Store(folder);await store.load();store.state.bootstrapFinished=true;const wire=new Wire(),messages:string[]=[];const scheduler=new Scheduler(store,{send:async text=>{messages.push(text);}});try{await run(store,wire,messages,scheduler);}finally{await rm(folder,{recursive:true,force:true});}}

test('crash after accepted PUT before applied save recovers urgent once without an LLM or another PUT',()=>fixture(async(store,wire,messages,scheduler)=>{
  await store.enqueue([{id:'tg:source',kind:'telegram',text:'Перенос ДЗ',date:'2026-10-13T10:00:00Z'}]);const queue=structuredClone(store.state.queue);
  const original=store.save.bind(store);let crash=true;
  store.save=async()=>{if(crash&&wire.puts===1)throw Error('Process died before applied checkpoint');await original();};
  await assert.rejects(()=>applyTaskOperation(wire,scheduler,store,'source-turn',moved,false),/died/);assert.equal(wire.puts,1);assert.equal(messages.length,0);
  const saved=JSON.parse(await readFile(join(store.dir,'operations.json'),'utf8'));assert.equal(Object.values(saved.taskOperations)[0]?.phase,'pending');
  crash=false;const recovered=new Store(store.dir);await recovered.load();const resumed=new Scheduler(recovered,{send:async text=>{messages.push(text);}});
  await recoverTaskOperations(wire,resumed,recovered);await recoverTaskOperations(wire,resumed,recovered);
  assert.equal(wire.puts,1);assert.equal(messages.length,1);assert.match(messages[0]!,/20 окт/);assert.deepEqual(recovered.state.queue,queue);assert.equal(Object.values(recovered.state.taskOperations!)[0]?.phase,'notified');
  await applyTaskOperation(wire,resumed,recovered,'source-turn',moved,false);assert.equal(wire.puts,1);assert.equal(messages.length,1);
}));
test('accepted PUT with a lost response uses readback and stable UID instead of reissuing the write',()=>fixture(async(store,wire,messages,scheduler)=>{
  wire.acceptedThenLost=true;await applyTaskOperation(wire,scheduler,store,'lost-response',moved,false);
  assert.equal(wire.puts,1);assert.equal(messages.length,1);assert.equal(Object.values(store.state.taskOperations!)[0]?.phase,'notified');
}));
test('third-state submission blocks a pending replay and never overwrites submitted with open',()=>fixture(async(store,wire,messages,scheduler)=>{
  await scheduler.sync([before]);store.state.notices[`urgent:${before.id}:${before.deadline}:open`]='Outdated deadline';await store.save();
  const original=store.save.bind(store);let intentWritten=false;
  store.save=async()=>{await original();if(!intentWritten){intentWritten=true;throw Error('Crash before PUT');}};
  await assert.rejects(()=>applyTaskOperation(wire,scheduler,store,'third-state',moved,false));assert.equal(wire.puts,0);
  wire.current={...before,status:'submitted'};const recovered=new Store(store.dir);await recovered.load();const resumed=new Scheduler(recovered,{send:async text=>{messages.push(text);}});
  await recoverTaskOperations(wire,resumed,recovered);assert.equal(wire.puts,0);assert.equal(wire.current.status,'submitted');assert.equal(Object.values(recovered.state.taskOperations!)[0]?.phase,'conflict');assert.equal(recovered.state.jobs.length,0);assert.equal(Object.keys(recovered.state.notices).some(key=>key.startsWith('urgent:')),false);
  await assert.rejects(()=>applyTaskOperation(wire,resumed,recovered,'third-state',moved,false),CalendarOperationConflict);
  await resumed.flushNotices(Date.now());assert.equal(messages.length,1);assert.match(messages[0]!,/изменился во время обработки/);
}));
test('source changes preserve an existing submitted status and no reminder jobs are created',()=>fixture(async(store,wire,_messages,scheduler)=>{
  wire.current={...before,status:'submitted'};const result=await applyTaskOperation(wire,scheduler,store,'source-new-date',moved,false);
  assert.equal(result.status,'submitted');assert.equal(wire.current?.status,'submitted');assert.equal(store.state.jobs.length,0);
}));
test('accepted cancellation recovered from absent stable UID removes reminder jobs and reports cancellation',()=>fixture(async(store,wire,messages,scheduler)=>{
  await scheduler.sync([before]);const original=store.save.bind(store);store.save=async()=>{if(wire.puts)throw Error('Crash after delete');await original();};
  await assert.rejects(()=>applyTaskOperation(wire,scheduler,store,'cancel',{...before,status:'cancelled'},false));assert.equal(wire.current,undefined);
  const recovered=new Store(store.dir);await recovered.load();const resumed=new Scheduler(recovered,{send:async text=>{messages.push(text);}});await recoverTaskOperations(wire,resumed,recovered);
  assert.equal(wire.puts,1);assert.equal(recovered.state.jobs.length,0);assert.match(messages[0]!,/^Отмена:/);
}));
test('a later accepted deadline supersedes the earlier undelivered intent; recovery sends only the latest',()=>fixture(async(store,wire,messages,_scheduler)=>{
  const offline=new Scheduler(store,{send:async()=>{throw Error('Bot unavailable');}});
  await applyTaskOperation(wire,offline,store,'first-change',moved,false);assert.equal(Object.values(store.state.taskOperations!)[0]?.phase,'applied');
  const latest={...moved,deadline:'2026-10-22T09:00:00.000Z'};
  await applyTaskOperation(wire,offline,store,'latest-change',latest,false);
  const recovered=new Store(store.dir);await recovered.load();const resumed=new Scheduler(recovered,{send:async text=>{messages.push(text);}});await recoverTaskOperations(wire,resumed,recovered);
  assert.equal(wire.puts,2);assert.equal(messages.length,1);assert.match(messages[0]!,/22 окт/);assert.doesNotMatch(messages[0]!,/20 окт/);
  assert.deepEqual(Object.values(recovered.state.taskOperations!).map(op=>op.phase),['superseded','notified']);
}));
