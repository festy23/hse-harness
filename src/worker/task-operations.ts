import {hash,validateTask,type Task,type Calendar} from '../domain.js';
import type {Store,TaskOperation} from '../store.js';
import type {Scheduler} from '../scheduler.js';
import {budgets,fatal,withOperation,type OperationContext} from '../operations.js';

type AttemptedOperation=TaskOperation&{writeAttempted?:boolean};
async function readTasks(calendar:Calendar,ctx:OperationContext):Promise<Task[]>{ctx.throwIfAborted();const tasks=await calendar.listTasks(ctx);ctx.throwIfAborted();return tasks;}

function taskPayload(task:Task):string {
  task=validateTask(task);
  return JSON.stringify([task.id,task.title,task.course,task.status,task.deadline??null,task.deadlineBasis,task.sources,task.disputed,task.notes]);
}
function same(actual:Task|undefined,expected:Task|undefined):boolean {
  return !actual||!expected?actual===expected:taskPayload(actual)===taskPayload(expected);
}
function desiredVisible(actual:Task|undefined,desired:Task):boolean {
  return desired.status==='cancelled'||!desired.deadline?actual===undefined:same(actual,desired);
}
const copy=(task:Task)=>structuredClone(validateTask(task));

export class CalendarOperationConflict extends Error { readonly source='state-conflict' as const; }

async function conflict(store:Store,scheduler:Scheduler,operation:TaskOperation,actual:Task|undefined):Promise<never> {
  operation.phase='conflict';
  // The fresh third state is authoritative for local reminders even though it
  // must not be overwritten. Do not deliver an older queued deadline notice.
  for(const key of Object.keys(store.state.notices))if(key.startsWith(`urgent:${operation.taskId}:`))delete store.state.notices[key];
  store.state.notices[`calendar-conflict:${operation.id}`]=`Календарь изменился во время обработки «${operation.desiredTask.title}». Сохранённое изменение не применено поверх новых данных. Проверь актуальную работу и уточни желаемый результат.`;
  delete store.state.notices[`calendar-uncertain:${operation.id}`];
  await scheduler.syncTask(operation.taskId,actual);
  throw new CalendarOperationConflict('Calendar task differs from both the saved before-state and desired result');
}
async function markApplied(store:Store,scheduler:Scheduler,operation:TaskOperation):Promise<void> {
  operation.phase='applied';
  // A known accepted status or deadline must affect reminders even if the next
  // calendar read is temporarily unavailable. Unknown sends stay pending.
  const urgent=`urgent:${operation.taskId}:${operation.desiredTask.deadline}:${operation.desiredTask.status}`;
  for(const key of Object.keys(store.state.notices))if(key.startsWith(`urgent:${operation.taskId}:`)&&key!==urgent)delete store.state.notices[key];
  delete store.state.notices[`calendar-uncertain:${operation.id}`];
  await scheduler.syncTask(operation.taskId,operation.desiredTask);
}

/** Caller holds Scheduler.transaction. Frozen before-state survives remote PUT→crash. */
async function complete(calendar:Calendar,scheduler:Scheduler,store:Store,operation:AttemptedOperation,ctx:OperationContext,snapshot?:Task[]):Promise<void> {
  if(['notified','superseded'].includes(operation.phase))return;
  let tasks=snapshot??await readTasks(calendar,ctx);
  let actual=tasks.find(task=>task.id===operation.taskId);
  if(!desiredVisible(actual,operation.desiredTask)){
    if(operation.phase==='conflict')throw new CalendarOperationConflict('Calendar operation awaits resolution');
    if(!same(actual,operation.beforeTask))await conflict(store,scheduler,operation,actual);
    if(operation.phase==='applied')throw new Error('Accepted calendar write is not visible yet; will recheck without repeating PUT');
    if(operation.writeAttempted!==false)throw new Error('Previous calendar write outcome is unconfirmed; refusing a blind repeat');
    operation.writeAttempted=true;await store.save();
    ctx.throwIfAborted();
    let writeError:unknown;
    try{await calendar.putTask(copy(operation.desiredTask),ctx);}
    catch(error){if(fatal(error))throw error;writeError=error;}
    if(writeError){
      // A lost response is reconciled using stable task UID. Never assume that
      // a failed request was rejected, and never blindly reapply over a third state.
      try{tasks=await readTasks(calendar,ctx);}catch(error){if(fatal(error))throw error;throw writeError;}
      actual=tasks.find(task=>task.id===operation.taskId);
      if(!desiredVisible(actual,operation.desiredTask)){
        if(!same(actual,operation.beforeTask))await conflict(store,scheduler,operation,actual);
        throw writeError;
      }
    }
    await markApplied(store,scheduler,operation);
    if(!writeError)tasks=await readTasks(calendar,ctx);
  }else if(operation.phase!=='applied')await markApplied(store,scheduler,operation);
  actual=tasks.find(task=>task.id===operation.taskId);
  if(!desiredVisible(actual,operation.desiredTask)){
    if(same(actual,operation.beforeTask))throw new Error('Accepted calendar write is not visible yet');
    await conflict(store,scheduler,operation,actual);
  }
  await scheduler.syncTask(operation.taskId,actual);
  const urgent=`urgent:${operation.taskId}:${operation.desiredTask.deadline}:${operation.desiredTask.status}`;
  for(const key of Object.keys(store.state.notices))if(key.startsWith(`urgent:${operation.taskId}:`)&&key!==urgent)delete store.state.notices[key];
  if(operation.notify)try{await scheduler.urgent(operation.desiredTask,operation.beforeTask,Date.now(),ctx);}
  catch(error){
    if(fatal(error))throw error;
    // Notification transport outage must not keep the source turn at the head
    // of the Pi queue, preventing a newer deadline from superseding it. The
    // accepted write and notification intent are durable; scheduler owns retry.
    if(!store.state.notices[urgent])throw error;
    await store.flush();return; // remains applied until the receipt is confirmed
  }
  operation.phase='notified';delete store.state.notices[`calendar-conflict:${operation.id}`];delete store.state.notices[`calendar-uncertain:${operation.id}`];await store.save();
}

export async function applyTaskOperation(calendar:Calendar,scheduler:Scheduler,store:Store,turnId:string,requestedTask:Task,ownerTurn:boolean,ctx?:OperationContext):Promise<Task> {
  const requested=copy(requestedTask);
  const id=`${turnId}:${requested.id}:${hash(taskPayload(requested))}`;
  return scheduler.transaction(()=>withOperation('tool',budgets.calendarMutation,ctx,async op=>{
    const operations=store.state.taskOperations??={};
    let operation:AttemptedOperation|undefined=operations[id];
    if(operation){await complete(calendar,scheduler,store,operation,op);return copy(operation.desiredTask);}
    const snapshot=await readTasks(calendar,op),before=snapshot.find(task=>task.id===requested.id);
    for(const previous of Object.values(operations) as AttemptedOperation[])if(previous.taskId===requested.id&&['pending','applied'].includes(previous.phase)&&(previous.phase==='applied'||previous.writeAttempted!==false)&&!desiredVisible(before,previous.desiredTask))
      throw new Error('Earlier calendar write must be reconciled before a newer task change');
    let desired=requested;
    if(['done','submitted'].includes(desired.status)&&before?.status!==desired.status&&!ownerTurn)throw new Error('Личный статус может менять только владелец в своем диалоге');
    if(!ownerTurn&&before&&['done','submitted'].includes(before.status)&&desired.status==='open')desired={...desired,status:before.status};
    operation={id,taskId:desired.id,beforeTask:before?copy(before):undefined,desiredTask:copy(desired),phase:'pending',writeAttempted:false,notify:store.state.bootstrapFinished,created:Date.now()};
    // Supersede only a visible accepted result, an unattempted local intent, or
    // a conflict resolved by this new intent. Unknown earlier writes stay fenced.
    for(const previous of Object.values(operations) as AttemptedOperation[])if(previous.taskId===desired.id&&['pending','applied','conflict'].includes(previous.phase)&&(previous.phase==='conflict'||previous.phase==='pending'&&previous.writeAttempted===false||desiredVisible(before,previous.desiredTask))){
      previous.phase='superseded';previous.supersededBy=id;
      delete store.state.notices[`calendar-conflict:${previous.id}`];delete store.state.notices[`calendar-uncertain:${previous.id}`];
    }
    operations[id]=operation;await store.save(); // durable intent precedes every PUT
    await complete(calendar,scheduler,store,operation,op,snapshot);
    return copy(operation.desiredTask);
  }),requested.id);
}

/** Recovers accepted writes and urgent notices without requiring an LLM turn. */
export async function recoverTaskOperations(calendar:Calendar,scheduler:Scheduler,store:Store,ctx?:OperationContext):Promise<void> {
  const groups=new Map<string,TaskOperation[]>();
  for(const operation of Object.values(store.state.taskOperations??{})){
    if(['notified','superseded'].includes(operation.phase))continue;
    groups.set(operation.taskId,[...(groups.get(operation.taskId)??[]),operation]);
  }
  const tasks=[...groups.entries()];let index=0;const failures:unknown[]=[];
  await Promise.all(Array.from({length:Math.min(4,tasks.length)},async()=>{
    while(index<tasks.length){
      const [taskId,operations]=tasks[index++]!;
      if(scheduler.busy(taskId))continue;
      try{await scheduler.transaction(async()=>{
        for(const operation of operations){
          try{await withOperation('tool',budgets.calendarMutation,ctx,op=>complete(calendar,scheduler,store,operation,op));}
          catch(error){if(fatal(error))throw error;await store.flush();break;}
        }
      },taskId);}catch(error){failures.push(error);}
    }
  }));
  if(failures.length)throw failures.find(fatal)??failures[0];
}
