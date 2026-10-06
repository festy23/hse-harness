import { deadline,hash,HISTORY_FROM,validateTask,type Calendar,type Lesson,type Task } from '../domain.js';
import type { Store } from '../store.js';
import type { CalendarCollection,CalendarEvent } from './collection.js';

/** Study rules are shared by every provider and by mixed-provider timetable/deadline roles. */
export class StudyCalendar implements Calendar {
  constructor(readonly timetable:CalendarCollection,readonly agent:CalendarCollection) {
    if(timetable.identity===agent.identity)throw new Error('Календарь дедлайнов должен отличаться от расписания');
  }
  async listTasks():Promise<Task[]> {
    return (await this.agent.list()).filter(e=>e.task&&e.status!=='cancelled').map(e=>{
      const t=validateTask({...e.task!});
      if(t.deadline&&e.start&&+new Date(e.start)!==+new Date(t.deadline))t.deadline=deadline(e.start).value;
      return t;
    });
  }
  async putTask(task:Task):Promise<void> {
    const t=validateTask(task),id=hash(t.id).slice(0,40);
    if(t.status==='cancelled'||!t.deadline){await this.agent.remove(id);return;}
    if(Buffer.byteLength(JSON.stringify(t))>20_000)throw new Error('Описание слишком длинное; сократите notes/источники');
    await this.agent.put({id,title:`${t.status==='submitted'?'✓ ':''}${t.course}: ${t.title}`,start:t.deadline,
      end:new Date(+new Date(t.deadline)+15*60_000).toISOString(),status:'confirmed',task:t,
      description:`${t.notes}\nСтатус: ${t.status}\nОснование срока: ${t.deadlineBasis}${t.disputed?'\nСрок спорный.':''}\nИсточники:\n${t.sources.join('\n')}`});
  }
  async lessons(from:string,to:string):Promise<Lesson[]> {
    return (await this.timetable.range(from,to)).filter(e=>e.status!=='cancelled'&&e.start&&e.end).map(e=>({id:e.id,title:e.title,start:e.start!,end:e.end!,...(e.allDay?{allDay:true}:{})}));
  }
  async changeLesson(id:string,start:string,end:string):Promise<void> {
    const a=deadline(start).value,b=deadline(end).value;
    if(+new Date(b)<=+new Date(a))throw new Error('Некорректный интервал занятия');
    await this.timetable.move(id,a,b);
  }
  async lessonPreview(id:string):Promise<string> {
    const event=await this.timetable.get(id);
    if(event.status==='cancelled')throw new Error('Занятие уже отменено');
    return `${event.title}\nСейчас: ${event.start??'Неизвестно'} → ${event.end??'Неизвестно'}`;
  }
  async syncSchedule(store:Store):Promise<void> {
    const key=this.timetable.identity,snapshotKey=`calendarSnapshot:${key}`;
    const result=await this.timetable.changes(store.state.calendarTokens[key]);
    const before=new Set<string>(JSON.parse(store.state.cursors[snapshotKey]??'[]'));
    const current=result.full?new Set<string>():new Set(before);
    const events=[...result.events];
    for(const e of events){if(e.status==='cancelled')current.delete(e.id);else current.add(e.id);}
    if(result.full)for(const id of before)if(!current.has(id)&&!events.some(e=>e.id===id))events.push({id,title:'Занятие удалено из расписания',status:'cancelled'});
    const sources=events.map(e=>({id:`calendar:${key}:${e.id}`,kind:'calendar' as const,date:e.start??HISTORY_FROM,
      text:JSON.stringify({title:e.title,start:e.start,end:e.end,allDay:e.allDay,status:e.status,description:e.description,recurrence:e.recurrence}),deleted:e.status==='cancelled'}));
    for(let i=0;i<sources.length;i+=20)await store.enqueue(sources.slice(i,i+20));
    store.state.cursors[snapshotKey]=JSON.stringify([...current]);
    if(result.cursor)store.state.calendarTokens[key]=result.cursor;else delete store.state.calendarTokens[key];
    await store.save();
  }
}
