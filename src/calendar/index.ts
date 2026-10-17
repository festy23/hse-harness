import { assertCalendarEnabled,type CalendarProvider,type CalendarSettings } from '../config.js';
import type { CalendarCollection } from './collection.js';
import { StudyCalendar } from './study-calendar.js';
import {budgets,withOperation,type OperationContext} from '../operations.js';

export type CalendarProviders=Record<'icloud'|'google',(id:string,ctx?:OperationContext)=>Promise<CalendarCollection>>&Partial<Record<'yandex',(id:string,ctx?:OperationContext)=>Promise<CalendarCollection>>>;
/** Providers are lazy: a disabled/unselected provider never loads credentials or opens a connection. */
function providers():CalendarProviders {
  let cloud:import('./providers/icloud.js').ICloudAccount|undefined;
  let google:import('../google.js').Google|undefined;
  let yandex:import('./providers/yandex.js').YandexAccount|undefined;
  return {
    async icloud(id,ctx){const {ICloudAccount}=await import('./providers/icloud.js');cloud??=new ICloudAccount();return cloud.collection(id,ctx);},
    async google(id){const {Google}=await import('../google.js');const {GoogleCollection}=await import('./providers/google.js');google??=new Google();return new GoogleCollection(google,id);},
    async yandex(id,ctx){const {YandexAccount}=await import('./providers/yandex.js');yandex??=new YandexAccount();return yandex.collection(id,ctx);},
  };
}
export async function createCalendar(config:CalendarSettings,registry:CalendarProviders=providers()):Promise<StudyCalendar>{
  const {timetable,agent}=config.calendars;
  assertCalendarEnabled(timetable.provider,config.features);assertCalendarEnabled(agent.provider,config.features);
  const open=(provider:CalendarProvider,id:string):CalendarCollection=>{
    const factory=registry[provider];if(!factory)throw new Error(`Не зарегистрирован календарь ${provider}`);
    let collection:CalendarCollection|undefined;
    const run=<T>(ctx:OperationContext|undefined,mutation:boolean,fn:(c:CalendarCollection,op:OperationContext)=>Promise<T>)=>withOperation(mutation?'tool':'source',mutation?budgets.calendarMutation:budgets.calendarScan,ctx,async op=>{
      // Failed discovery is never cached; the next independently admitted operation retries.
      const current=collection??await factory(id,op);op.throwIfAborted();collection=current;
      return fn(current,op);
    });
    return {identity:`${provider}:${id}`,list:ctx=>run(ctx,false,(c,op)=>c.list(op)),range:(from,to,ctx)=>run(ctx,false,(c,op)=>c.range(from,to,op)),
      changes:(cursor,ctx)=>run(ctx,false,(c,op)=>c.changes(cursor,op)),get:(event,ctx)=>run(ctx,false,(c,op)=>c.get(event,op)),
      put:(event,ctx)=>run(ctx,true,(c,op)=>c.put(event,op)),remove:(event,ctx)=>run(ctx,true,(c,op)=>c.remove(event,op)),move:(event,start,end,ctx)=>run(ctx,true,(c,op)=>c.move(event,start,end,op))};
  };
  const schedule=open(timetable.provider,timetable.id),tasks=open(agent.provider,agent.id);
  return new StudyCalendar(schedule,tasks);
}
export { StudyCalendar } from './study-calendar.js';
export type { CalendarCollection,CalendarEvent,CalendarChanges } from './collection.js';
