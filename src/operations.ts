import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';

export type OperationKind='source'|'owner-command'|'tool'|'approval'|'connect'|'request'|'cleanup'|'cpu';
export type FailureKind='cancelled'|'deadline'|'transport'|'rate-limit'|'authentication'|'permission'|'provider-rejection'|'protocol'|'payload-limit'|'durability'|'invariant';
export class OperationError extends Error {
  constructor(readonly kind:FailureKind,message:string,readonly reason?:'drain'|'stop'|'request'|'operation') {super(message);this.name='OperationError';}
}
export interface OperationContext {
  readonly id:string;
  readonly kind:OperationKind;
  readonly signal:AbortSignal;
  readonly deadlineMonoMs:number;
  remainingMs():number;
  throwIfAborted():void;
}
export const budgets={rpc:30_000,connect:120_000,telegramSlice:60_000,history:45_000,question:45_000,addChat:120_000,mailSlice:120_000,message:45_000,calendarRequest:30_000,calendarScan:120_000,calendarMutation:90_000,hse:45_000,cleanup:5_000,cpu:30_000} as const;
export type OperationParent=OperationContext|AbortSignal|undefined;
export interface OperationScope extends OperationContext {abort(reason?:unknown):void;dispose():void}
const active=new Map<string,{kind:OperationKind;started:number;deadline:number}>();
export function activeOperations(){const now=performance.now();return [...active].map(([id,x])=>({id,kind:x.kind,ageMs:Math.round(now-x.started),remainingMs:Math.max(0,Math.round(x.deadline-now))}));}
export function createOperation(kind:OperationKind,budgetMs:number,parent?:OperationParent):OperationScope {
  if(!Number.isFinite(budgetMs)||budgetMs<=0)throw new RangeError('Invalid operation budget');
  const context=parent&&'remainingMs' in parent?parent:undefined;
  const signal=context?.signal??(parent as AbortSignal|undefined);
  const controller=new AbortController();
  const id=randomUUID();
  const deadlineMonoMs=performance.now()+Math.min(budgetMs,context?.remainingMs()??Infinity);
  active.set(id,{kind,started:performance.now(),deadline:deadlineMonoMs});
  const abort=()=>controller.abort(signal?.reason instanceof OperationError?signal.reason:new OperationError('cancelled','Операция отменена'));
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(new OperationError('deadline','Превышено время операции',kind==='request'?'request':'operation')),Math.max(0,deadlineMonoMs-performance.now()));
  timer.unref();
  return {id,kind,signal:controller.signal,deadlineMonoMs,
    remainingMs:()=>Math.max(0,deadlineMonoMs-performance.now()),
    throwIfAborted:()=>{if(performance.now()>=deadlineMonoMs&&!controller.signal.aborted)controller.abort(new OperationError('deadline','Превышено время операции',kind==='request'?'request':'operation'));controller.signal.throwIfAborted();},
    abort:reason=>controller.abort(reason??new OperationError('cancelled','Операция отменена')),
    dispose:()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);active.delete(id);}};
}
export async function withOperation<T>(kind:OperationKind,budgetMs:number,parent:OperationParent,run:(ctx:OperationContext)=>Promise<T>):Promise<T> {
  const scope=createOperation(kind,budgetMs,parent);
  try{scope.throwIfAborted();const result=await run(scope);scope.throwIfAborted();return result;}
  catch(error){if(fatal(error))throw error;scope.throwIfAborted();throw error;}
  finally{scope.dispose();}
}
export function cancelled(error:unknown):boolean {
  if(error instanceof OperationError)return error.kind==='cancelled';
  if(error instanceof Error&&error.name==='AbortError')return !(error.cause instanceof OperationError)||error.cause.kind==='cancelled';
  return false;
}
export function fatal(error:unknown):boolean {return error instanceof OperationError&&['durability','invariant'].includes(error.kind);}
export async function operationSleep(ms:number,ctx?:OperationContext):Promise<void>{try{await pause(ms,undefined,{signal:ctx?.signal});}catch(error){if(ctx?.signal.aborted)throw ctx.signal.reason;throw error;}}
export async function yieldIfNeeded(since:number,signal?:AbortSignal):Promise<number>{
  signal?.throwIfAborted();
  if(performance.now()-since>=5){await new Promise<void>(resolve=>setImmediate(resolve));signal?.throwIfAborted();return performance.now();}
  return since;
}
