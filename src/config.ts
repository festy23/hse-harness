import 'dotenv/config';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export type CalendarProvider = 'icloud' | 'google' | 'yandex';
export interface CalendarSelection {provider:CalendarProvider;id:string;label?:string}
export interface CalendarFeatures {googleCalendar:boolean;icloudCalendar:boolean;yandexCalendar?:boolean}
export interface StudyProfile {name:string;university:string;program:string;group:string;course:number;academicYear:string;subjects:string;details:string}
export const legacyProfile:StudyProfile={name:'Иван',university:'ВШЭ ФКН',program:'Программная инженерия',group:'БПИ243',course:3,academicYear:'2026/27',subjects:'Кодинговые агенты в разработке',details:'Набор 2024; поток C#; майнор: Финансовые рынки; НИС: Нейроинформатика'};
export interface CalendarSettings {features:CalendarFeatures;calendars:{timetable:CalendarSelection;agent:CalendarSelection}}
export interface Config extends CalendarSettings {
  ownerId: number;
  chats: {id:string; title:string}[];
  folders: string[];
  model: string;
  pollSeconds: number;
  profile?:StudyProfile;
}
export function assertCalendarEnabled(provider:CalendarProvider,features:CalendarFeatures):void {
  if(provider==='google'&&!features.googleCalendar)throw new Error('Google Calendar отключен feature flag features.googleCalendar');
  if(provider==='icloud'&&!features.icloudCalendar)throw new Error('iCloud Calendar отключен feature flag features.icloudCalendar');
  if(provider==='yandex'&&!features.yandexCalendar)throw new Error('Яндекс Календарь отключен feature flag features.yandexCalendar');
}
export function calendarSettings(value:unknown):CalendarSettings {
  const raw=value as Partial<CalendarSettings>;
  const features={googleCalendar:false,icloudCalendar:true,...raw.features};
  if(typeof features.googleCalendar!=='boolean'||typeof features.icloudCalendar!=='boolean'||(features.yandexCalendar!==undefined&&typeof features.yandexCalendar!=='boolean'))throw new Error('Календарные feature flags должны быть boolean');
  const calendars={timetable:{provider:'icloud',id:'your-icloud-timetable-url'},agent:{provider:'icloud',id:'your-icloud-agent-calendar-url'},...raw.calendars} as CalendarSettings['calendars'];
  for(const selection of Object.values(calendars)) {
    if(!selection||!['icloud','google','yandex'].includes(selection.provider)||typeof selection.id!=='string'||!selection.id.trim())throw new Error('Укажите provider/id для каждой календарной роли');
    assertCalendarEnabled(selection.provider,features);
  }
  if(calendars.timetable.provider===calendars.agent.provider&&calendars.timetable.id===calendars.agent.id)throw new Error('Нужны два разных календаря: расписание и дедлайны');
  return {features,calendars};
}
export async function readConfigFile():Promise<Record<string,unknown>> {
  const path=process.env.STUDY_CONFIG ?? 'config.local.json';
  const contents=await readFile(path,'utf8').catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')throw new Error('Создайте config.local.json из config.example.json; настройка описана в README');throw e;});
  return JSON.parse(contents);
}
export async function loadConfig(): Promise<Config> {
  const raw=await readConfigFile();
  if(('timetableId' in raw||'agentCalendarId' in raw)&&!raw.calendars)throw new Error('Обновите старый формат календарей по config.example.json: Google теперь отключен, провайдер выбирается явно');
  const c = {...raw,...calendarSettings(raw)} as unknown as Config;
  if (!Number.isSafeInteger(c.ownerId) || c.ownerId <= 0) throw new Error('Укажите ownerId в config.local.json');
  if (!Array.isArray(c.chats) || c.chats.some(x => !/^-?\d+$/.test(x.id))) throw new Error('chats должны содержать числовые id');
  // A model is required for Pi turns, not for the owner's /start and /status.
  return {...c,model:typeof c.model==='string'?c.model:'',folders:c.folders ?? [],pollSeconds:Math.max(15,c.pollSeconds ?? 60)};
}
export function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Не настроен ${name}; см. .env.example`);
  return value;
}
export const dataDir = () => resolve(process.env.STUDY_DATA_DIR ?? 'data');
export const secretsDir = () => resolve(process.env.STUDY_SECRETS_DIR ?? 'secrets');
export async function directories(): Promise<void> {
  await Promise.all([dataDir(),secretsDir(),join(dataDir(),'pi')].map(p=>mkdir(p,{recursive:true,mode:0o700})));
}
