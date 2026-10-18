import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as pause } from 'node:timers/promises';

export type WorkerMode = 'inactive' | 'active' | 'draining' | 'quiescent' | 'finishing' | 'stopped';

/** Admission applies to roots, not tools inside an already accepted turn. */
export class WorkerLifecycle {
  mode: WorkerMode = 'inactive';
  private readonly scope = new AsyncLocalStorage<boolean>();
  private count = 0;
  private readonly changes = new Set<() => void>();
  private readonly modeChanges = new Set<() => void>();
  get inFlight(): number { return this.count; }
  get accepting(): boolean { return this.mode === 'active'; }
  get terminal(): boolean { return this.mode === 'finishing' || this.mode === 'stopped'; }
  private changed(mode=false): void {
    for (const fn of [...this.changes]) fn();
    if(mode)for(const fn of [...this.modeChanges])fn();
  }
  activate(): void {
    if (this.terminal) throw new Error('Terminal worker cannot resume');
    this.mode = 'active'; this.changed(true);
  }
  drain(): void {
    if (!this.accepting && this.mode !== 'draining') throw new Error('Worker is not active');
    this.mode = 'draining'; this.changed(true);
  }
  quiescent(): void {
    if (this.mode !== 'draining' || this.count) throw new Error('Worker is not drained');
    this.mode = 'quiescent'; this.changed(true);
  }
  finish(): void {
    if (this.mode !== 'quiescent') throw new Error('Finish requires quiescent worker');
    this.mode = 'finishing'; this.changed(true);
  }
  stop(): void { this.mode = 'stopped'; this.changed(true); }
  async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (!this.scope.getStore() && !this.accepting) return undefined;
    this.count++;
    try { return await this.scope.run(true, operation); }
    finally { this.count--; this.changed(); }
  }
  async idle(whileWaiting?:()=>boolean): Promise<void> {
    if (!this.count || whileWaiting?.()===false) return;
    await new Promise<void>(resolve => {
      const check = () => { if (!this.count || whileWaiting?.()===false) { this.changes.delete(check); resolve(); } };
      this.changes.add(check); check();
    });
  }
  async waitActive(): Promise<void> {
    if (this.accepting || this.terminal) return;
    await new Promise<void>(resolve => {
      const check = () => { if (this.accepting || this.terminal) { this.modeChanges.delete(check); resolve(); } };
      this.modeChanges.add(check); check();
    });
  }
  /** Retries wake on drain/resume/stop instead of holding a transaction open. */
  async sleep(ms: number): Promise<void> {
    if (this.terminal) return;
    const controller=new AbortController();const wake=()=>controller.abort();this.modeChanges.add(wake);
    try{await pause(ms,undefined,{signal:controller.signal});}
    catch(error){if((error as NodeJS.ErrnoException).name!=='AbortError')throw error;}
    finally{this.modeChanges.delete(wake);}
  }
}

export interface WorkerCommand {
  protocolVersion: 1;
  attemptId: string;
  workerId: string;
  sequence: number;
  type: 'prepare' | 'activate' | 'drain' | 'resume' | 'finish' | 'notice';
  text?: string;
  id?: string;
}

/** Strict command sequence prevents a cancelled drain acknowledging a later switch. */
export class WorkerControl {
  private latest?: WorkerCommand;
  private acknowledgement?: string;
  private heartbeat?: NodeJS.Timeout;
  private prepared = false;
  constructor(readonly lifecycle: WorkerLifecycle, readonly workerId: string,
    readonly actions: { prepare(): Promise<void>; activate(): Promise<void>; checkpoint(): Promise<void>;
      finish(): Promise<void>; notice(text: string, id: string): Promise<void>; health(): unknown;transition?(mode:WorkerMode):void },
    readonly send: (message: Record<string, unknown>) => void) {}
  private reply(command: WorkerCommand, type: string, extra: Record<string, unknown> = {}): void {
    if (this.latest !== command) return;
    this.acknowledgement = type;
    this.send({ protocolVersion: 1, attemptId: command.attemptId, workerId: this.workerId, sequence: command.sequence, type, ...extra });
  }
  async receive(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || JSON.stringify(value).length > 16_384) return;
    const c = value as WorkerCommand;
    if (c.protocolVersion !== 1 || c.workerId !== this.workerId || typeof c.attemptId !== 'string' || !c.attemptId || c.attemptId.length > 128 || !Number.isSafeInteger(c.sequence) || c.sequence < 1 || !['prepare','activate','drain','resume','finish','notice'].includes(c.type)) return;
    // Notifications are independent of the control transaction. A racing notice
    // cannot invalidate a drain's sequence or manufacture a quiescent ACK.
    if(c.type==='notice'){
      if(typeof c.text!=='string'||c.text.length>8000||typeof c.id!=='string'||c.id.length>200||!this.lifecycle.accepting)return;
      try{await this.lifecycle.run(async()=>{
        await this.actions.notice(c.text!,c.id!);
        this.send({protocolVersion:1,attemptId:c.attemptId,workerId:this.workerId,sequence:c.sequence,type:'notice-sent',id:c.id});
      });}catch{this.fatal('state-invariant','Worker notice persistence failed');throw new Error('Worker notice persistence failed');}
      return;
    }
    if (this.latest && c.sequence <= this.latest.sequence) {
      if (c.sequence === this.latest.sequence && c.attemptId === this.latest.attemptId && c.type === this.latest.type && this.acknowledgement) this.reply(this.latest, this.acknowledgement);
      return;
    }
    // A transaction may change its attemptId, but sequence is monotonic per incarnation.
    this.latest = c; this.acknowledgement = undefined;
    try {
      if (c.type === 'prepare') {
        if (this.prepared || this.lifecycle.mode !== 'inactive') throw new Error('Prepare is only valid before activation');
        await this.actions.prepare(); this.prepared = true; this.reply(c, 'boot-ready');
        this.heartbeat = setInterval(() => {
          try{
          const current = this.latest;
          if (current) this.send({ protocolVersion: 1, attemptId: current.attemptId, workerId: this.workerId,
            sequence: current.sequence, type: 'health', mode: this.lifecycle.mode, inFlight: this.lifecycle.inFlight,
            version: process.env.HSE_RELEASE_VERSION, health: this.actions.health() });
          }catch{this.fatal('state-invariant','Worker health callback failed');}
        }, 5000);
      } else if (c.type === 'activate') {
        if (!this.prepared || this.lifecycle.mode !== 'inactive') throw new Error('Invalid activation');
        this.lifecycle.activate();this.actions.transition?.('active'); await this.actions.activate(); this.reply(c, 'active');
      } else if (c.type === 'drain') {
        this.lifecycle.drain();this.actions.transition?.('draining'); this.reply(c, 'draining');
        await this.lifecycle.idle(()=>this.latest===c&&this.lifecycle.mode==='draining');
        if (this.latest !== c || this.lifecycle.mode !== 'draining') return;
        await this.actions.checkpoint();
        if (this.latest !== c || this.lifecycle.mode !== 'draining') return;
        this.lifecycle.quiescent(); this.reply(c, 'quiescent');
      } else if (c.type === 'resume') {
        if (!['draining','quiescent'].includes(this.lifecycle.mode)) throw new Error('Invalid resume');
        this.lifecycle.activate();this.actions.transition?.('active'); this.reply(c, 'active');
      } else if (c.type === 'finish') {
        this.lifecycle.finish(); this.reply(c, 'exiting'); this.close(); await this.actions.finish();
      }
    } catch(error) {
      this.reply(c, c.type === 'prepare' ? 'boot-failed' : 'fatal', { code: 'state-invariant', detail: 'Worker lifecycle or checkpoint failed' });
      throw error;
    }
  }
  close(): void { if (this.heartbeat) clearInterval(this.heartbeat); }
  fatal(code:'release'|'state-invariant'|'protocol',detail:string):void {
    if(this.latest)this.reply(this.latest,'fatal',{code,detail});
  }
}
