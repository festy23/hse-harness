import { type Task, reminderJobs, moscowDate, moscowHour, prettyTime } from './domain.js';
import type { Store } from './store.js';
import type { Notifier } from './bot.js';

export class Scheduler {
  private calendarTail:Promise<void>=Promise.resolve();
  constructor(readonly store:Store,readonly bot:Notifier) {}
  transaction<T>(run:()=>Promise<T>):Promise<T> {
    const result=this.calendarTail.then(run,run);
    this.calendarTail=result.then(()=>{},()=>{});return result;
  }
  async sync(tasks:Task[]):Promise<void> {
    this.store.state.jobs=tasks.flatMap(reminderJobs);
    await this.store.save();
  }
  async tick(now=Date.now()):Promise<void> {
    await this.flushNotices(now);
    const due=this.store.state.jobs.filter(j=>j.due<=now && !this.store.state.delivered[j.id]);
    const groups=new Map<string,typeof due>();
    for(const j of due) groups.set(j.taskId,[...(groups.get(j.taskId)??[]),j]);
    for(const jobs of groups.values()) {
      jobs.sort((a,b)=>b.due-a.due);
      const latest=jobs[0]!;
      if(!this.store.state.jobs.some(j=>j.id===latest.id))continue;
      const late=now-latest.due>120_000;
      await this.bot.send(late ? `Напоминание восстановлено с задержкой.\n${latest.text.replace(/^До сдачи осталось[^:]*:/,'Проверь актуальный срок:')}` : latest.text);
      for(const j of jobs) this.store.state.delivered[j.id]=now;
      await this.store.save();
    }
  }
  async urgent(t:Task,previous:Task|undefined,now=Date.now()):Promise<void> {
    const changed=previous && (previous.deadline!==t.deadline || t.status==='cancelled' && previous.status!=='cancelled');
    const near=!previous && t.deadline && +new Date(t.deadline)-now<86400_000;
    if (!changed && !near) return;
    const key=`urgent:${t.id}:${t.deadline}:${t.status}`;
    for(const pending of Object.keys(this.store.state.notices)) {
      if(pending.startsWith(`urgent:${t.id}:`) && pending!==key)delete this.store.state.notices[pending];
    }
    if(this.store.state.delivered[key]) {await this.store.save();return;}
    this.store.state.notices[key]=t.status==='cancelled' ? `Отмена: ${t.course} — ${t.title}` : `Изменение/близкий срок: ${t.course} — ${t.title}\n${t.deadline ? prettyTime(t.deadline) : 'Срок уточняется'}${t.disputed?'\nСрок спорный.':''}`;
    await this.store.save();await this.flushNotices(now);
  }
  private async flushNotices(now:number):Promise<void> {
    for(const [key,text] of Object.entries(this.store.state.notices)) {
      if(!this.store.state.delivered[key])await this.bot.send(text);
      this.store.state.delivered[key]=now;delete this.store.state.notices[key];await this.store.save();
    }
  }
  async digests(now=Date.now()):Promise<void> {
    const hour=moscowHour(now);
    if (hour!==10 && hour!==20) return;
    const id=`digest:${moscowDate(now)}:${hour}`;
    if(this.store.state.delivered[id] || this.store.state.queue.some(x=>x.id===id)) return;
    this.store.state.queue.push({id,sources:[],digest:hour===10?'morning':'evening'});
    await this.store.save();
  }
}
