import { assertCalendarEnabled,type CalendarProvider,type CalendarSettings } from '../config.js';
import type { CalendarCollection } from './collection.js';
import { StudyCalendar } from './study-calendar.js';

export type CalendarProviders=Record<'icloud'|'google',(id:string)=>Promise<CalendarCollection>>&Partial<Record<'yandex',(id:string)=>Promise<CalendarCollection>>>;
/** Providers are lazy: a disabled/unselected provider never loads credentials or opens a connection. */
function providers():CalendarProviders {
  let cloud:import('./providers/icloud.js').ICloudAccount|undefined;
  let google:import('../google.js').Google|undefined;
  let yandex:import('./providers/yandex.js').YandexAccount|undefined;
  return {
    async icloud(id){const {ICloudAccount}=await import('./providers/icloud.js');cloud??=new ICloudAccount();return cloud.collection(id);},
    async google(id){const {Google}=await import('../google.js');const {GoogleCollection}=await import('./providers/google.js');google??=new Google();return new GoogleCollection(google,id);},
    async yandex(id){const {YandexAccount}=await import('./providers/yandex.js');yandex??=new YandexAccount();return yandex.collection(id);},
  };
}
export async function createCalendar(config:CalendarSettings,registry:CalendarProviders=providers()):Promise<StudyCalendar>{
  const {timetable,agent}=config.calendars;
  assertCalendarEnabled(timetable.provider,config.features);assertCalendarEnabled(agent.provider,config.features);
  const open=(provider:CalendarProvider,id:string)=>{const factory=registry[provider];if(!factory)throw new Error(`Не зарегистрирован календарь ${provider}`);return factory(id);};
  const [schedule,tasks]=await Promise.all([open(timetable.provider,timetable.id),open(agent.provider,agent.id)]);
  return new StudyCalendar(schedule,tasks);
}
export { StudyCalendar } from './study-calendar.js';
export type { CalendarCollection,CalendarEvent,CalendarChanges } from './collection.js';
