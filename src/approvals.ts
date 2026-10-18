import { randomUUID, randomBytes } from 'node:crypto';
import type { Store, Approval } from './store.js';
import type { Notifier } from './bot.js';
import {budgets,withOperation,fatal,OperationError,type OperationContext} from './operations.js';

export interface ApprovalSender {
  question(chat:string,text:string,randomId:string,ctx?:OperationContext): Promise<string>;
  lesson(id:string,start:string,end:string,ctx?:OperationContext): Promise<void>;
  previewLesson?(id:string,ctx?:OperationContext):Promise<string>;
  lessonMatches?(id:string,start:string,end:string,ctx?:OperationContext):Promise<boolean>;
}
export class Approvals {
  private inFlight=new Set<string>();
  constructor(readonly store:Store, readonly bot:Notifier, readonly sender:ApprovalSender, readonly allowedChats:Set<string>) {}
  async propose(kind:Approval['kind'], payload:Approval['payload'], now=Date.now(),ctx?:OperationContext): Promise<string> {
    if (kind === 'question' && (!payload.chat || !this.allowedChats.has(payload.chat) || !payload.text?.trim() || payload.text.length > 3500)) throw new Error('Чат или текст уточнения недопустим');
    if (kind === 'lesson' && (!payload.lessonId || !payload.start || !payload.end || +new Date(payload.end) <= +new Date(payload.start))) throw new Error('Некорректная правка занятия');
    if(kind==='lesson'&&this.sender.previewLesson)payload={...payload,preview:await this.sender.previewLesson(payload.lessonId!,ctx)};
    const existing=this.store.state.approvals.find(a=>a.kind===kind && JSON.stringify(a.payload)===JSON.stringify(payload) && a.state!=='rejected' && now-a.created<86400_000);
    if(existing){if(existing.state==='pending'&&!existing.notified)await this.show(existing,ctx);return existing.id;}
    const a:Approval = {id:randomUUID(),kind,payload:{...payload},randomId:randomBytes(8).readBigInt64BE().toString(),state:'pending',created:now};
    this.store.state.approvals.push(a); await this.store.save();
    await this.show(a,ctx);
    return a.id;
  }
  private async show(a:Approval,ctx?:OperationContext):Promise<void> {
    const {kind,payload}=a;
    await this.bot.send(kind === 'question' ? `Отправить вопрос в чат ${payload.chat}?\n\n${payload.text}` : `Изменить занятие ${payload.lessonId}?\n${payload.preview??''}\nНовый интервал: ${payload.start} → ${payload.end}`, [[
      {text:'Подтвердить',callback_data:`approve:${a.id}`},{text:'Отклонить',callback_data:`reject:${a.id}`},
    ]],`approval:${a.id}`,ctx);
    a.notified=true;await this.store.save();
  }
  async decide(id:string, accept:boolean, now=Date.now(),ctx?:OperationContext): Promise<void> {
    const a=this.store.state.approvals.find(x=>x.id === id);
    if (!a || a.state !== 'pending') return;
    if (!accept) { a.state='rejected'; await this.store.save(); return; }
    if (now-a.created > 86400_000) { a.state='rejected'; await this.store.save(); throw new Error('Черновик старше суток; подтвердите новый'); }
    a.state='sending'; await this.store.save();
    await this.execute(a,now,ctx);
  }
  private async execute(a:Approval, now:number,parent?:OperationContext): Promise<void> {
    if(this.inFlight.has(a.id))return;
    this.inFlight.add(a.id);
    try {
    await withOperation('approval',a.kind==='question'?budgets.question:budgets.calendarMutation,parent,async ctx=>{
    if (a.kind === 'question') {
      if (!this.allowedChats.has(a.payload.chat!)) throw new OperationError('permission','Чат больше не разрешен');
      a.messageId=await this.sender.question(a.payload.chat!,a.payload.text!,a.randomId,ctx);
    } else {
      const id=a.payload.lessonId!,start=a.payload.start!,end=a.payload.end!;
      if(!await this.sender.lessonMatches?.(id,start,end,ctx)){
        if(this.sender.previewLesson){
          const current=await this.sender.previewLesson(id,ctx);
          if(a.payload.preview===undefined||current!==a.payload.preview){
            a.state='rejected';
            this.store.state.notices[`stale-lesson:${a.id}`]='Занятие изменилось после подготовки черновика. Старое одобрение отменено; для нового переноса нужно новое подтверждение.';
            await this.store.save();throw new Error('Занятие изменилось; требуется новый черновик и согласие');
          }
        }
        await this.sender.lesson(id,start,end,ctx);
      }
    }
    a.state='sent'; a.sent=now; await this.store.save();
    });
    }catch(error){
      if(error instanceof OperationError&&error.kind==='permission'){
        a.state='rejected';
        this.store.state.notices[`blocked-approval:${a.id}`]='Повтор согласованного действия прекращён: доступ отозван. Исход прошлой попытки может быть неизвестен; проверь его перед новым подтверждением.';
        await this.store.save();
      }
      throw error;
    }finally{this.inFlight.delete(a.id);}
  }
  async recover(ctx?:OperationContext): Promise<void> {
    // Telegram random_id повторяется: неоднозначный сетевой результат не создает вторую отправку.
    const pending=this.store.state.approvals.filter(x=>x.state==='sending');let failure:unknown;
    for(let i=0;i<pending.length;i+=4){
      ctx?.throwIfAborted();
      const results=await Promise.allSettled(pending.slice(i,i+4).map(a=>this.execute(a,Date.now(),ctx)));
      for(const r of results)if(r.status==='rejected'){if(fatal(r.reason))throw r.reason;failure??=r.reason;}
    }
    if(failure)throw failure;
  }
  async reply(chat:string, replyTo:string): Promise<void> {
    const a=this.store.state.approvals.find(x=>x.kind==='question' && x.state==='sent' && x.payload.chat === chat && x.messageId === replyTo);
    if (a) { a.answered=true; await this.store.save(); }
  }
  async tick(now=Date.now(),ctx?:OperationContext): Promise<void> {
    for (const a of this.store.state.approvals) {
      ctx?.throwIfAborted();
      const key=`no-answer:${a.id}`;
      if (a.kind==='question' && a.state==='sent' && !a.answered && a.sent && now-a.sent >= 86400_000 && !this.store.state.delivered[key]) {
        await this.bot.send(`На вопрос в чате ${a.payload.chat} нет ответа сутки. Нужна твоя помощь.\n${a.payload.text}`,undefined,key,ctx);
        this.store.state.delivered[key]=now; await this.store.save();
      }
    }
  }
}
