import {test} from 'node:test';
import assert from 'node:assert/strict';
import {studyTools,readHse} from '../src/tools.js';
import {OperationError,createOperation,type OperationContext} from '../src/operations.js';
import type {Calendar} from '../src/domain.js';

test('SDK third execute signal reaches the tool operation and its calendar request before settlement',async()=>{
  const sdk=new AbortController();let reached:OperationContext|undefined,settled=false;
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const calendar={listTasks:async(ctx?:OperationContext)=>{
    reached=ctx;entered();
    try{await new Promise<void>((resolve,reject)=>{ctx!.signal.addEventListener('abort',()=>reject(ctx!.signal.reason),{once:true});});}
    finally{settled=true;}
    return [];
  }} as Calendar;
  const tools=studyTools({calendar} as Parameters<typeof studyTools>[0]);
  const result=tools.find(t=>t.name==='list_tasks')!.execute('fixture',{},sdk.signal,undefined,undefined as never);
  const rejected=assert.rejects(result,(error:unknown)=>error instanceof OperationError&&error.kind==='cancelled');
  await started;assert.ok(reached);assert.equal(reached.kind,'tool');sdk.abort(new OperationError('cancelled','Fixture cancellation'));await rejected;assert.equal(settled,true);
});

test('a cancelled HSE request never starts external work',async()=>{
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async()=>{requests++;throw new Error('unexpected request');};
  const ctx=createOperation('tool',1000);ctx.abort();
  try{await assert.rejects(readHse('https://hse.ru/course',0,ctx));assert.equal(requests,0);}
  finally{globalThis.fetch=original;ctx.dispose();}
});
