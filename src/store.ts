import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, validateTask, type Job, type Source, type Task } from './domain.js';
import {stableVersion,type AvailableRelease} from './updates/releases.js';

export interface NpmUpdateState {
  botIdentity?:string;
  checkedAt?:number;
  lastOfferedAt?:number;
  latest?:AvailableRelease;
  offer?:AvailableRelease&{id:string};
  pendingNotice?:{id:string;text:string;offerId:string;version:string};
  request?:AvailableRelease&{id:string;workerId:string;phase:'authorizing'|'pending'|'installing'|'awaiting-apply'|'completed'|'failed';created:number};
}

export interface TaskOperation {
  id:string;
  taskId:string;
  beforeTask?:Task;
  desiredTask:Task;
  phase:'pending'|'applied'|'notified'|'conflict'|'superseded';
  notify:boolean;
  created:number;
  supersededBy?:string;
}

export interface Approval {
  id: string;
  kind: 'question' | 'lesson';
  payload: { chat?: string; text?: string; lessonId?: string; start?: string; end?: string; preview?:string };
  randomId: string;
  state: 'pending' | 'sending' | 'sent' | 'rejected';
  created: number;
  sent?: number;
  messageId?: string;
  answered?: boolean;
  notified?: boolean;
}
export interface State {
  npmUpdates?:NpmUpdateState;
  schemaVersion: 2;
  sessionPath?: string;
  botOffset: number;
  botIdentity?: string;
  cursors: Record<string, string>;
  queue: {id: string; sources: Source[]; ownerText?: string; digest?: string; phase?: 'prompting' | 'answer'; answer?: string}[];
  ownerUpdates: Record<string, true>;
  outbox: Record<string, {text: string; buttons?: unknown; chunks: {state: 'pending' | 'sending' | 'sent'; messageId?: number}[]; created: number; ambiguous?: boolean}>;
  missedDigests: Record<string, number>;
  taskOperations?:Record<string,TaskOperation>;
  seen: Record<string, string>;
  jobs: Job[];
  delivered: Record<string, number>;
  approvals: Approval[];
  calendarTokens: Record<string,string>;
  health: Record<string,string>;
  bootstrapFinished: boolean;
  notices: Record<string,string>;
}
const empty = (): State => ({schemaVersion:2,botOffset:0,cursors:{},queue:[],ownerUpdates:{},outbox:{},missedDigests:{},taskOperations:{},seen:{},jobs:[],delivered:{},approvals:[],calendarTokens:{},health:{},bootstrapFinished:false,notices:{}});

export class Store {
  state: State = empty();
  private writes: Promise<void> = Promise.resolve();
  private writeFailure?: unknown;
  constructor(readonly dir: string) {}
  async load(options: {readOnly?: boolean} = {}): Promise<void> {
    if (!options.readOnly) await mkdir(this.dir, {recursive:true, mode:0o700});
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.dir,'operations.json'),'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid operations state');
      const s = raw as Partial<State>;
      const update=s.npmUpdates;
      if(update!==undefined){
        if(!update||typeof update!=='object')throw new Error('Invalid npm update state');
        for(const field of ['checkedAt','lastOfferedAt'] as const)if(update[field]!==undefined&&!Number.isFinite(update[field]))throw new Error('Invalid update timestamp');
        if(update.botIdentity!==undefined&&typeof update.botIdentity!=='string')throw new Error('Invalid update bot identity');
        if(update.pendingNotice&&(!update.pendingNotice||typeof update.pendingNotice.id!=='string'||typeof update.pendingNotice.text!=='string'||!stableVersion(update.pendingNotice.version)||typeof update.pendingNotice.offerId!=='string'))throw new Error('Invalid update notification');
        for(const item of [update.latest,update.offer,update.request])if(item!==undefined&&(!item||!stableVersion(item.version)||typeof item.integrity!=='string'||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity)))throw new Error('Invalid update release');
        for(const item of [update.offer,update.request])if(item!==undefined&&!/^[a-f0-9-]{36}$/.test(item.id))throw new Error('Invalid update nonce');
        if(update.request&&(!['authorizing','pending','installing','awaiting-apply','completed','failed'].includes(update.request.phase)||typeof update.request.workerId!=='string'||!Number.isFinite(update.request.created)))throw new Error('Invalid update request');
      }
      const version=(raw as {schemaVersion?:number}).schemaVersion;
      if (version !== undefined && ![1,2].includes(version)) throw new Error('Unsupported operations format');
      if (!Number.isSafeInteger(s.botOffset) || s.botOffset! < 0 || !Array.isArray(s.queue) || !Array.isArray(s.jobs) || !Array.isArray(s.approvals)) throw new Error('Invalid operations state');
      if(s.botIdentity!==undefined&&(typeof s.botIdentity!=='string'||!/^telegram:(?:\d{1,20}|opaque:[0-9a-f]{24})$/.test(s.botIdentity)))throw new Error('Invalid bot identity');
      for (const field of ['cursors','seen','delivered','calendarTokens','health','notices','ownerUpdates','outbox','missedDigests','taskOperations'] as const) {
        if (s[field] !== undefined && (!s[field] || typeof s[field] !== 'object' || Array.isArray(s[field]))) throw new Error(`Invalid state field ${field}`);
      }
      if (s.queue.some(item => !item || typeof item.id !== 'string' || !Array.isArray(item.sources) || (item.phase!==undefined&&!['prompting','answer'].includes(item.phase)) || (item.answer!==undefined&&typeof item.answer!=='string'))) throw new Error('Invalid queue');
      for(const delivery of Object.values(s.outbox??{})){
        if(!delivery||typeof delivery.text!=='string'||!Array.isArray(delivery.chunks)||delivery.chunks.some(chunk=>!chunk||!['pending','sending','sent'].includes(chunk.state)))throw new Error('Invalid delivery receipt');
      }
      for(const [id,operation] of Object.entries(s.taskOperations??{})){
        if(!operation||operation.id!==id||typeof operation.taskId!=='string'||!['pending','applied','notified','conflict','superseded'].includes(operation.phase)||typeof operation.notify!=='boolean'||!Number.isFinite(operation.created))throw new Error('Invalid calendar operation');
        validateTask(operation.desiredTask);if(operation.beforeTask)validateTask(operation.beforeTask);
        if(operation.desiredTask.id!==operation.taskId||operation.beforeTask&&operation.beforeTask.id!==operation.taskId)throw new Error('Invalid calendar operation task ID');
      }
      this.state = {...empty(), ...s, schemaVersion:2};
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  async save(): Promise<void> {
    const snapshot = JSON.stringify(this.state);
    const write = async () => {
      const path = join(this.dir,'operations.json');
      const temp = path + '.' + randomUUID();
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(snapshot); await handle.sync(); } finally { await handle.close(); }
      await rename(temp,path);
      const directory = await open(this.dir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    };
    this.writes = this.writes.then(write,write).catch(error => { this.writeFailure ??= error; throw error; });
    return this.writes;
  }
  async flush(): Promise<void> {
    await this.writes;
    if (this.writeFailure) throw this.writeFailure;
  }
  async enqueue(sources: Source[]): Promise<void> {
    const accepted = sources.filter(s => this.state.seen[s.id] !== hash(JSON.stringify(s)));
    if (!accepted.length) return;
    for (const s of accepted) this.state.seen[s.id] = hash(JSON.stringify(s));
    const pieces:Source[]=[];
    for(const s of accepted) {
      if(s.text.length<=6000){pieces.push(s);continue;}
      const total=Math.ceil(s.text.length/5800);
      for(let i=0,offset=0;offset<s.text.length;i++,offset+=5800) pieces.push({...s,text:`[Часть ${i+1}/${total} одного источника ${s.id}; границы перекрываются]\n${s.text.slice(offset,offset+6000)}`});
    }
    for(let i=0;i<pieces.length;i+=4)this.state.queue.push({id:randomUUID(),sources:pieces.slice(i,i+4)});
    await this.save();
  }
  /** Invoked after activation, never as part of readonly prepare. */
  async activateBot(identity:string|undefined):Promise<void> {
    if(!identity||this.state.botIdentity===identity)return;
    if(this.state.botIdentity===undefined){
      // Legacy receipts came from the same previously configured bot. Adopt
      // its identity without losing the committed offset or queued operation IDs.
      for(const key of Object.keys(this.state.ownerUpdates))if(/^\d+$/.test(key))this.state.ownerUpdates[`${identity}:${key}`]=true;
    }else this.state.botOffset=0;
    this.state.botIdentity=identity;await this.save();
  }
  async enqueueOwner(ownerText: string, updateId?: number, identity=this.state.botIdentity): Promise<void> {
    const key = updateId === undefined ? undefined : identity?`${identity}:${updateId}`:String(updateId);
    if (key && this.state.ownerUpdates[key]) return;
    this.state.queue.push({id:key ? `owner:${key}` : randomUUID(),sources:[],ownerText});
    if (key) { this.state.ownerUpdates[key] = true; this.state.botOffset = Math.max(this.state.botOffset, updateId! + 1); }
    await this.save();
  }
}

export async function writeSecret(path: string, content: string): Promise<void> {
  const temp = path + '.' + randomUUID();
  const handle=await open(temp,'wx',0o600);
  try{await handle.writeFile(content);await handle.sync();}finally{await handle.close();}
  await rename(temp,path);
}

export async function processLock(dir: string, filename = 'service.lock'): Promise<() => Promise<void>> {
  await mkdir(dir,{recursive:true,mode:0o700});
  const path = join(dir,filename);
  const identity = JSON.stringify({pid:process.pid,nonce:randomUUID(),workerId:process.env.HSE_WORKER_ID,startedAt:new Date().toISOString()});
  for(let attempt=0;attempt<2;attempt++) {
    let handle;
    try {
      handle=await open(path,'wx',0o600);await handle.writeFile(identity);await handle.sync();await handle.close();handle=undefined;
      return async()=>{try{if(await readFile(path,'utf8')===identity)await unlink(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}};
    }catch(error){
      await handle?.close();if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    }
    // Serialize only dead-owner reclamation; ordinary uncontended startup has
    // no recovery guard to strand. An interrupted recovery remains blocked.
    const recoveryPath=path+'.recovery';let guard;
    try{guard=await open(recoveryPath,'wx',0o600);}
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error(`Writer lock recovery interrupted or in progress; inspect ${filename}.recovery`);throw error;}
    try{
      const previous=await readFile(path,'utf8');let pid:number;
      try{const value:unknown=JSON.parse(previous);pid=typeof value==='number'?value:Number((value as {pid?:number})?.pid);}
      catch{throw new Error('Неизвестный lock; требуется проверка владельцем');}
      if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Неизвестный lock; требуется проверка владельцем');
      try{process.kill(pid,0);throw new Error('Другой экземпляр сервиса уже работает');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      if(await readFile(path,'utf8')!==previous)throw new Error('Lock изменился при проверке');
      const stale=path+'.stale-'+randomUUID();await rename(path,stale);
      // Never unlink the original path after recovery: another contender may
      // have acquired it since rename. Only the detached old record is ours.
      await unlink(stale);
    }finally{await guard.close();await unlink(recoveryPath);}
  }
  throw new Error('Не удалось получить writer lock');
}
