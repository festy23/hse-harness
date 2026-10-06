import { mkdir, readFile, rename, writeFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, type Job, type Source } from './domain.js';

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
  sessionPath?: string;
  botOffset: number;
  cursors: Record<string, string>;
  queue: {id: string; sources: Source[]; ownerText?: string; digest?: string}[];
  seen: Record<string, string>;
  jobs: Job[];
  delivered: Record<string, number>;
  approvals: Approval[];
  calendarTokens: Record<string,string>;
  health: Record<string,string>;
  bootstrapFinished: boolean;
  notices: Record<string,string>;
}
const empty = (): State => ({botOffset:0,cursors:{},queue:[],seen:{},jobs:[],delivered:{},approvals:[],calendarTokens:{},health:{},bootstrapFinished:false,notices:{}});

export class Store {
  state: State = empty();
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly dir: string) {}
  async load(): Promise<void> {
    await mkdir(this.dir, {recursive:true, mode:0o700});
    try { this.state = {...empty(), ...JSON.parse(await readFile(join(this.dir,'operations.json'),'utf8'))}; }
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
    };
    this.writes = this.writes.then(write,write);
    return this.writes;
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
  async enqueueOwner(ownerText: string): Promise<void> {
    this.state.queue.push({id:randomUUID(),sources:[],ownerText});
    await this.save();
  }
}

export async function writeSecret(path: string, content: string): Promise<void> {
  const temp = path + '.' + randomUUID();
  await writeFile(temp,content,{mode:0o600});
  await rename(temp,path);
}

export async function processLock(dir: string): Promise<() => Promise<void>> {
  await mkdir(dir,{recursive:true,mode:0o700});
  const path = join(dir,'service.lock');
  try {
    const old = Number(await readFile(path,'utf8'));
    try { process.kill(old,0); throw new Error('Другой экземпляр сервиса уже работает'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    await unlink(path);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const handle = await open(path,'wx',0o600);
  await handle.writeFile(String(process.pid)); await handle.close();
  return async () => { await unlink(path); };
}
