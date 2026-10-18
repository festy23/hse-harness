import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,type TaskOperation} from '../src/store.js';
import {Scheduler} from '../src/scheduler.js';
import {applyTaskOperation,recoverTaskOperations} from '../src/worker/task-operations.js';
import {OperationError} from '../src/operations.js';
import {reminderJobs,type Calendar,type Task} from '../src/domain.js';
const task=(id:string,changes:Partial<Task>={}):Task=>({id,title:id,course:'Testing',status:'open',deadline:'2026-10-18T09:00:00.000Z',deadlineBasis:'explicit',sources:['fixture'],disputed:false,notes:'',...changes});
const now=Date.parse('2026-10-18T08:30:00Z');
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
async function eventually(predicate:()=>boolean){const until=Date.now()+2000;while(!predicate()){if(Date.now()>until)throw Error('Concurrent task did not progress');await new Promise(resolve=>setTimeout(resolve,5));}}
async function fixture(run:(store:Store)=>Promise<void>){const folder=await mkdtemp(join(tmpdir(),'scheduler-concurrency-'));const store=new Store(folder);await store.load();store.state.bootstrapFinished=true;try{await run(store);}finally{await rm(folder,{recursive:true,force:true});}}
function operation(id:string,before:Task,desired:Task):TaskOperation&{writeAttempted:boolean}{return {id,taskId:before.id,beforeTask:before,desiredTask:desired,phase:'pending',notify:true,created:Date.now(),writeAttempted:false};}
function wire(tasks:Task[]):Calendar&{current:Task[];puts:number}{return {current:structuredClone(tasks),puts:0,async listTasks(){return structuredClone(this.current);},async putTask(t){this.puts++;this.current=this.current.filter(x=>x.id!==t.id);if(t.status!=='cancelled'&&t.deadline)this.current.push(structuredClone(t));},async lessons(){return [];},async changeLesson(){}};}

test('a task held in calendar work does not block another known reminder',()=>fixture(async store=>{
  const messages:string[]=[];const scheduler=new Scheduler(store,{send:async text=>{messages.push(text);}});
  await scheduler.sync([task('alpha'),task('beta')]);const gate=deferred(),entered=deferred();
  const busy=scheduler.transaction(async()=>{entered.resolve();await gate.promise;},'alpha');await entered.promise;
  try{await scheduler.tick(now);assert.equal(messages.length,1);assert.match(messages[0]!,/beta/);}finally{gate.resolve();await busy;}
}));

test('a delayed reminder transport for one task does not hold a different task behind it',()=>fixture(async store=>{
  const gate=deferred(),entered=deferred();const messages:string[]=[];
  const scheduler=new Scheduler(store,{send:async text=>{if(text.includes('alpha')){entered.resolve();await gate.promise;}messages.push(text);}});
  await scheduler.sync([task('alpha'),task('beta')]);const ticking=scheduler.tick(now);await entered.promise;
  try{await eventually(()=>messages.some(text=>text.includes('beta')));}finally{gate.resolve();await ticking;}
}));

test('a stale calendar snapshot cannot restore jobs changed by an accepted task operation',()=>fixture(async store=>{
  const before=task('alpha'),moved=task('alpha',{deadline:'2026-10-22T09:00:00.000Z'});
  const calendar=wire([before]),scheduler=new Scheduler(store,{send:async()=>{}});await scheduler.sync([before]);
  const gate=deferred(),entered=deferred(),list=calendar.listTasks.bind(calendar);let calls=0;
  calendar.listTasks=async ctx=>{if(++calls===1){const old=await list(ctx);entered.resolve();await gate.promise;return old;}return list(ctx);};
  const refreshing=scheduler.refresh(calendar);await entered.promise;
  try{await applyTaskOperation(calendar,scheduler,store,'move',moved,false);}finally{gate.resolve();await refreshing;}
  assert.deepEqual(store.state.jobs,reminderJobs(moved));
}));

test('recovery works on other tasks while the first calendar read is delayed',()=>fixture(async store=>{
  const a=task('alpha'),b=task('beta'),nextA=task('alpha',{deadline:'2026-10-22T09:00:00.000Z'}),nextB=task('beta',{deadline:'2026-10-23T09:00:00.000Z'});
  store.state.taskOperations={a:operation('a',a,nextA),b:operation('b',b,nextB)};await store.save();
  const calendar=wire([a,b]),gate=deferred(),entered=deferred(),list=calendar.listTasks.bind(calendar);let calls=0;
  calendar.listTasks=async ctx=>{if(++calls===1){entered.resolve();await gate.promise;}return list(ctx);};
  const scheduler=new Scheduler(store,{send:async()=>{}}),recovery=recoverTaskOperations(calendar,scheduler,store);await entered.promise;
  try{await eventually(()=>store.state.taskOperations!.b!.phase==='notified');assert.equal(store.state.taskOperations!.a!.phase,'pending');}
  finally{gate.resolve();await recovery;}
  assert.equal(calendar.puts,2);assert.equal(store.state.taskOperations.a!.phase,'notified');
}));

test('one failed recovery read is isolated while fatal durability failures are surfaced',()=>fixture(async store=>{
  const a=task('alpha'),b=task('beta');store.state.taskOperations={a:operation('a',a,{...a,notes:'a'}),b:operation('b',b,{...b,notes:'b'})};
  const calendar=wire([a,b]),list=calendar.listTasks.bind(calendar);let reads=0;
  calendar.listTasks=async ctx=>{if(++reads===1)throw Error('Temporary read outage');return list(ctx);};
  const scheduler=new Scheduler(store,{send:async()=>{}});await recoverTaskOperations(calendar,scheduler,store);
  assert.equal(store.state.taskOperations.a!.phase,'pending');assert.equal(store.state.taskOperations.b!.phase,'notified');
  store.save=async()=>{throw new OperationError('durability','Fixture durable failure');};
  await assert.rejects(()=>recoverTaskOperations(calendar,scheduler,store),error=>error instanceof OperationError&&error.kind==='durability');
}));

test('an unknown PUT is never blindly repeated and creates one durable uncertainty notice alongside other reminders',()=>fixture(async store=>{
  const a=task('alpha'),b=task('beta'),calendar=wire([a,b]),messages:string[]=[];
  calendar.putTask=async()=>{calendar.puts++;throw Error('Write response lost');};
  const scheduler=new Scheduler(store,{send:async text=>{messages.push(text);}});await scheduler.sync([a,b]);
  await assert.rejects(()=>applyTaskOperation(calendar,scheduler,store,'unknown',{...a,deadline:'2026-10-23T09:00:00.000Z'},false),/lost/);
  await recoverTaskOperations(calendar,scheduler,store);assert.equal(calendar.puts,1);
  await scheduler.tick(now);await scheduler.tick(now+1000);
  assert.equal(messages.filter(text=>text.includes('не подтверждены')).length,1);
  assert.equal(messages.filter(text=>text.includes('beta')).length,1);
  assert.equal(messages.some(text=>text.includes('alpha')&&!text.includes('не подтверждены')),false);
  const persisted=JSON.parse(await readFile(join(store.dir,'operations.json'),'utf8'));
  assert.equal(persisted.schemaVersion,2);assert.equal(Object.values(persisted.taskOperations)[0]!.writeAttempted,true);
  await assert.rejects(()=>applyTaskOperation(calendar,scheduler,store,'newer',{...a,status:'submitted'},true),/Earlier calendar write/);
  assert.equal(calendar.puts,1);
}));

test('an existing schema2 pending intent without an attempt marker is conservatively reconciled without another PUT',()=>fixture(async store=>{
  const a=task('alpha'),op:TaskOperation={id:'old',taskId:a.id,beforeTask:a,desiredTask:{...a,notes:'new'},phase:'pending',notify:true,created:1};
  store.state.taskOperations={old:op};const calendar=wire([a]);
  await recoverTaskOperations(calendar,new Scheduler(store,{send:async()=>{}}),store);
  assert.equal(calendar.puts,0);assert.equal(op.phase,'pending');
}));

test('same-task status mutation waits for an already admitted reminder send and removes subsequent jobs',()=>fixture(async store=>{
  const a=task('alpha'),calendar=wire([a]),gate=deferred(),entered=deferred();
  const scheduler=new Scheduler(store,{send:async()=>{entered.resolve();await gate.promise;}});await scheduler.sync([a]);
  const ticking=scheduler.tick(now);await entered.promise;
  const updating=applyTaskOperation(calendar,scheduler,store,'submitted',{...a,status:'submitted'},true);
  try{await new Promise(resolve=>setImmediate(resolve));assert.equal(calendar.puts,0);}finally{gate.resolve();await ticking;await updating;}
  assert.equal(calendar.puts,1);assert.equal(store.state.jobs.length,0);
}));

test('a known accepted write awaiting visibility fences refresh and newer same-task writes',()=>fixture(async store=>{
  const a=task('alpha'),desired={...a,deadline:'2026-10-23T09:00:00.000Z'},calendar=wire([a]);
  calendar.putTask=async()=>{calendar.puts++;}; // provider accepted, read replica still returns the old task
  const scheduler=new Scheduler(store,{send:async()=>{}});await scheduler.sync([a]);
  await assert.rejects(()=>applyTaskOperation(calendar,scheduler,store,'accepted',desired,false),/not visible/);
  assert.equal(Object.values(store.state.taskOperations!)[0]!.phase,'applied');
  await scheduler.refresh(calendar);assert.deepEqual(store.state.jobs,reminderJobs(desired));
  await assert.rejects(()=>applyTaskOperation(calendar,scheduler,store,'newer',{...a,status:'submitted'},true),/Earlier calendar write/);
  assert.equal(calendar.puts,1);
}));

test('a slow unrelated notice cannot hold known reminder delivery behind it',()=>fixture(async store=>{
  const gate=deferred(),entered=deferred(),messages:string[]=[];
  const scheduler=new Scheduler(store,{send:async(text,_buttons,id)=>{if(id==='runtime:slow'){entered.resolve();await gate.promise;}messages.push(text);}});
  await scheduler.sync([task('beta')]);store.state.notices['runtime:slow']='Runtime notice';await store.save();
  const ticking=scheduler.tick(now);await entered.promise;
  try{await eventually(()=>messages.some(text=>text.includes('beta')));}finally{gate.resolve();await ticking;}
}));
