import {parentPort} from 'node:worker_threads';
import {htmlCompute} from './html.js';
import {calendarCompute} from '../calendar/compute.js';
import {OperationError} from '../operations.js';
import type {ComputeJob} from './jobs.js';

parentPort!.on('message',({id,job}:{id:number;job:ComputeJob})=>{
  try{
    const value=job.type==='html'?htmlCompute(job):calendarCompute(job);
    parentPort!.postMessage({id,ok:true,value});
  }catch(error){
    parentPort!.postMessage({id,ok:false,error:{kind:error instanceof OperationError?error.kind:'protocol',message:error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[URL]').slice(0,500):'Вычисление не выполнено'}});
  }
});
