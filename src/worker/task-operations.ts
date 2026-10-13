import {hash,validateTask,reminderJobs,type Task,type Calendar} from '../domain.js';
import type {Store,TaskOperation} from '../store.js';
import type {Scheduler} from '../scheduler.js';

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

async function conflict(store:Store,operation:TaskOperation,actual:Task|undefined):Promise<never> {
  operation.phase='conflict';
  // The fresh third state is authoritative for local reminders even though it
  // must not be overwritten. Do not deliver an older queued deadline notice.
  store.state.jobs=[...store.state.jobs.filter(job=>job.taskId!==operation.taskId),...(actual?reminderJobs(actual):[])];
  for(const key of Object.keys(store.state.notices))if(key.startsWith(`urgent:${operation.taskId}:`))delete store.state.notices[key];
  store.state.notices[`calendar-conflict:${operation.id}`]=`Календарь изменился во время обработки «${operation.desiredTask.title}». Сохранённое изменение не применено поверх новых данных. Проверь актуальную работу и уточни желаемый результат.`;
  await store.save();
  throw new CalendarOperationConflict('Calendar task differs from both the saved before-state and desired result');
}
async function markApplied(store:Store,operation:TaskOperation):Promise<void> {
  operation.phase='applied';
  // A known accepted status or deadline must affect reminders even if the next
  // calendar read is temporarily unavailable. Unknown sends stay pending.
  store.state.jobs=[...store.state.jobs.filter(job=>job.taskId!==operation.taskId),...reminderJobs(operation.desiredTask)];
  await store.save();
}

/** Caller holds Scheduler.transaction. Frozen before-state survives remote PUT→crash. */
async function complete(calendar:Calendar,scheduler:Scheduler,store:Store,operation:TaskOperation,snapshot?:Task[]):Promise<void> {
  if(['notified','superseded'].includes(operation.phase))return;
  let tasks=snapshot??await calendar.listTasks();
  let actual=tasks.find(task=>task.id===operation.taskId);
  if(!desiredVisible(actual,operation.desiredTask)){
    if(operation.phase==='conflict')throw new CalendarOperationConflict('Calendar operation awaits resolution');
    if(!same(actual,operation.beforeTask))await conflict(store,operation,actual);
    if(operation.phase==='applied')throw new Error('Accepted calendar write is not visible yet; will recheck without repeating PUT');
    let writeError:unknown;
    try{await calendar.putTask(copy(operation.desiredTask));}
    catch(error){writeError=error;}
    if(writeError){
      // A lost response is reconciled using stable task UID. Never assume that
      // a failed request was rejected, and never blindly reapply over a third state.
      try{tasks=await calendar.listTasks();}catch{throw writeError;}
      actual=tasks.find(task=>task.id===operation.taskId);
      if(!desiredVisible(actual,operation.desiredTask)){
        if(!same(actual,operation.beforeTask))await conflict(store,operation,actual);
        throw writeError;
      }
    }
    await markApplied(store,operation);
    if(!writeError)tasks=await calendar.listTasks();
  }else if(operation.phase!=='applied')await markApplied(store,operation);
  actual=tasks.find(task=>task.id===operation.taskId);
  if(!desiredVisible(actual,operation.desiredTask)){
    if(same(actual,operation.beforeTask))throw new Error('Accepted calendar write is not visible yet');
    await conflict(store,operation,actual);
  }
  await scheduler.sync(tasks);
  const urgent=`urgent:${operation.taskId}:${operation.desiredTask.deadline}:${operation.desiredTask.status}`;
  for(const key of Object.keys(store.state.notices))if(key.startsWith(`urgent:${operation.taskId}:`)&&key!==urgent)delete store.state.notices[key];
  if(operation.notify)try{await scheduler.urgent(operation.desiredTask,operation.beforeTask);}
  catch(error){
    // Notification transport outage must not keep the source turn at the head
    // of the Pi queue, preventing a newer deadline from superseding it. The
    // accepted write and notification intent are durable; scheduler owns retry.
    if(!store.state.notices[urgent])throw error;
    await store.flush();return; // remains applied until the receipt is confirmed
  }
  operation.phase='notified';delete store.state.notices[`calendar-conflict:${operation.id}`];await store.save();
}

export async function applyTaskOperation(calendar:Calendar,scheduler:Scheduler,store:Store,turnId:string,requestedTask:Task,ownerTurn:boolean):Promise<Task> {
  const requested=copy(requestedTask);
  const id=`${turnId}:${requested.id}:${hash(taskPayload(requested))}`;
  return scheduler.transaction(async()=>{
    const operations=store.state.taskOperations??={};
    let operation=operations[id];
    if(operation){await complete(calendar,scheduler,store,operation);return copy(operation.desiredTask);}
    const snapshot=await calendar.listTasks(),before=snapshot.find(task=>task.id===requested.id);
    let desired=requested;
    if(['done','submitted'].includes(desired.status)&&before?.status!==desired.status&&!ownerTurn)throw new Error('Личный статус может менять только владелец в своем диалоге');
    if(!ownerTurn&&before&&['done','submitted'].includes(before.status)&&desired.status==='open')desired={...desired,status:before.status};
    operation={id,taskId:desired.id,beforeTask:before?copy(before):undefined,desiredTask:copy(desired),phase:'pending',notify:store.state.bootstrapFinished,created:Date.now()};
    // A later admitted change may supersede an undelivered earlier change, but
    // only when its desired result is the actual frozen before-state.
    for(const previous of Object.values(operations))if(previous.taskId===desired.id&&['pending','applied'].includes(previous.phase)&&desiredVisible(before,previous.desiredTask)){
      previous.phase='superseded';previous.supersededBy=id;
    }
    operations[id]=operation;await store.save(); // durable intent precedes every PUT
    await complete(calendar,scheduler,store,operation,snapshot);
    return copy(operation.desiredTask);
  });
}

/** Recovers accepted writes and urgent notices without requiring an LLM turn. */
export async function recoverTaskOperations(calendar:Calendar,scheduler:Scheduler,store:Store):Promise<void> {
  await scheduler.transaction(async()=>{
    for(const operation of Object.values(store.state.taskOperations??{})){
      if(['notified','superseded'].includes(operation.phase))continue;
      try{await complete(calendar,scheduler,store,operation);}
      catch(error){if(!(error instanceof CalendarOperationConflict))throw error;}
    }
  });
}
