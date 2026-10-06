import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarSettings } from '../src/config.js';
import { StudyCalendar } from '../src/calendar/study-calendar.js';
import type { CalendarCollection, CalendarEvent } from '../src/calendar/collection.js';
import type { Task } from '../src/domain.js';
import { CalDAVCollection } from '../src/calendar/providers/caldav.js';
import type { DAVCalendarObject } from 'tsdav';
import { createCalendar } from '../src/calendar/index.js';
import { Store } from '../src/store.js';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function davFixture(){
  const objects=new Map<string,DAVCalendarObject>();let revision=1;let conflict=false;
  const client={
    async fetchCalendarObjects({objectUrls}:{objectUrls?:string[]}){return [...objects.values()].filter(o=>!objectUrls||objectUrls.includes(o.url)).map(o=>({...o}));},
    async createCalendarObject({calendar,filename,iCalString,headers}:any){assert.equal(headers['If-None-Match'],'*');const url=calendar.url+filename;if(objects.has(url))return new Response('',{status:412});objects.set(url,{url,data:iCalString,etag:String(revision++)});return new Response('',{status:201});},
    async updateCalendarObject({calendarObject}:any){if(conflict)return new Response('',{status:412});assert.equal(objects.get(calendarObject.url)?.etag,calendarObject.etag);objects.set(calendarObject.url,{...calendarObject,etag:String(revision++)});return new Response(null,{status:204});},
    async deleteCalendarObject({calendarObject}:any){assert.equal(objects.get(calendarObject.url)?.etag,calendarObject.etag);objects.delete(calendarObject.url);return new Response(null,{status:204});},
  };
  return {objects,client,setConflict:()=>{conflict=true;}};
}

class Collection implements CalendarCollection {
  constructor(readonly identity:string,readonly events=new Map<string,CalendarEvent>()){}
  async list(){return [...this.events.values()];}
  async range(){return this.list();}
  async changes(){return {events:await this.list(),full:true};}
  async get(id:string){const e=this.events.get(id);if(!e)throw new Error('Not found');return e;}
  async put(e:CalendarEvent){this.events.set(e.id,structuredClone(e));}
  async remove(id:string){this.events.delete(id);}
  async move(id:string,start:string,end:string){this.events.set(id,{...await this.get(id),start,end});}
}

test('Google выключен по умолчанию; обе календарные роли используют iCloud, отключенный провайдер нельзя выбрать',()=>{
  const defaults=calendarSettings({});
  assert.deepEqual(defaults.features,{googleCalendar:false,icloudCalendar:true});
  assert.equal(defaults.calendars.timetable.provider,'icloud');assert.equal(defaults.calendars.agent.provider,'icloud');
  assert.throws(()=>calendarSettings({calendars:{timetable:{provider:'google',id:'schedule'},agent:{provider:'icloud',id:'agent'}}}),/Google.*отключен/);
  const enabled=calendarSettings({features:{googleCalendar:true},calendars:{timetable:{provider:'google',id:'schedule'},agent:{provider:'icloud',id:'agent'}}});
  assert.equal(enabled.calendars.timetable.provider,'google');assert.equal(enabled.calendars.agent.provider,'icloud');
});
test('Фабрика не загружает выключенный Google и проверяет flags до подключения обоих провайдеров',async()=>{
  const loaded:string[]=[];
  const registry={icloud:async(id:string)=>{loaded.push(id);return new Collection('icloud:'+id);},google:async()=>{throw new Error('Google не должен загружаться');}};
  await createCalendar(calendarSettings({}),registry);assert.equal(loaded.length,2);
  loaded.length=0;
  await assert.rejects(()=>createCalendar({features:{googleCalendar:false,icloudCalendar:true},calendars:{timetable:{provider:'icloud',id:'schedule'},agent:{provider:'google',id:'agent'}}},registry),/Google.*отключен/);
  assert.equal(loaded.length,0);
});
test('Полный снимок CalDAV сообщает удаление после рестарта; сбой чтения не отменяет занятия',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'calendar-sync-'));
  try{
    const schedule=new Collection('icloud:schedule'),calendar=new StudyCalendar(schedule,new Collection('icloud:agent'));
    schedule.events.set('seminar',{id:'seminar',title:'Семинар',start:'2026-10-09T07:00:00Z',end:'2026-10-09T08:00:00Z'});
    let store=new Store(dir);await store.load();await calendar.syncSchedule(store);
    store=new Store(dir);await store.load();const original=schedule.changes.bind(schedule);
    schedule.changes=async()=>{throw new Error('offline');};
    await assert.rejects(()=>calendar.syncSchedule(store),/offline/);
    assert.equal(store.state.queue.flatMap(b=>b.sources).filter(s=>s.deleted).length,0);
    schedule.changes=original;schedule.events.clear();await calendar.syncSchedule(store);
    assert.equal(store.state.queue.flatMap(b=>b.sources).filter(s=>s.deleted).length,1);
    await calendar.syncSchedule(store);assert.equal(store.state.queue.flatMap(b=>b.sources).filter(s=>s.deleted).length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('CalDAV записывает событие на весь день с VALUE=DATE',async()=>{
  const wire=davFixture(),backend=new CalDAVCollection(wire.client,{url:'https://caldav.icloud.com/agent/'},'icloud:agent');
  await backend.put({id:'day',title:'День',allDay:true,start:'2026-10-10',end:'2026-10-11'});
  assert.match([...wire.objects.values()][0]!.data,/DTSTART;VALUE=DATE:20261010/);
  assert.equal((await backend.list())[0]?.allDay,true);
});
test('Перенос экземпляра серии на весь день сохраняет DATE recurrence-id и остальные дни',async()=>{
  const wire=davFixture(),url='https://caldav.icloud.com/schedule/day.ics';
  wire.objects.set(url,{url,etag:'0',data:['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:day','DTSTART;VALUE=DATE:20261010','DTEND;VALUE=DATE:20261011','RRULE:FREQ=WEEKLY;COUNT=3','SUMMARY:День','END:VEVENT','END:VCALENDAR'].join('\r\n')});
  const backend=new CalDAVCollection(wire.client,{url:'https://caldav.icloud.com/schedule/'},'icloud:schedule');
  const id=(await backend.range('2026-10-01','2026-11-01')).find(e=>e.start==='2026-10-17')!.id;
  await backend.move(id,'2026-10-18T07:00:00Z','2026-10-18T08:00:00Z');
  assert.match(wire.objects.get(url)!.data,/RECURRENCE-ID;VALUE=DATE:20261017/);
  assert.equal((await backend.get(id)).start,'2026-10-18T07:00:00.000Z');
  assert.equal((await backend.range('2026-10-01','2026-11-01')).length,3);
});
test('CalDAV сохраняет кириллицу/метаданные, переносит стабильный дедлайн с ETag и снимает отмену; конфликт записи не затирает событие',async()=>{
  const wire=davFixture(),backend=new CalDAVCollection(wire.client,{url:'https://caldav.icloud.com/agent/'},'icloud:agent');
  const calendar=new StudyCalendar(new Collection('icloud:schedule'),backend);
  const task:Task={id:'hw',title:'ДЗ; тест',course:'Нейроинформатика',status:'open',deadline:'2026-10-09T09:00:00Z',deadlineBasis:'explicit',sources:['tg:123:42'],disputed:false,notes:'Содержание\n'+ 'я'.repeat(2000)};
  await calendar.putTask(task);assert.equal(wire.objects.size,1);
  const first=(await calendar.listTasks())[0]!;assert.equal(first.notes,task.notes);assert.equal(first.title,task.title);
  await calendar.putTask({...task,deadline:'2026-10-10T09:00:00Z'});assert.equal(wire.objects.size,1);assert.equal((await calendar.listTasks())[0]?.deadline,'2026-10-10T09:00:00.000Z');
  wire.setConflict();await assert.rejects(()=>calendar.putTask({...task,deadline:'2026-10-11T09:00:00Z'}),/412/);
  assert.equal((await calendar.listTasks())[0]?.deadline,'2026-10-10T09:00:00.000Z');
  await calendar.putTask({...task,status:'cancelled'});assert.equal(wire.objects.size,0);
});
test('Учебные правила общие для провайдеров: дедлайн имеет стабильное событие, отмена снимает его, правка занятия остается в расписании',async()=>{
  const schedule=new Collection('icloud:schedule'),agent=new Collection('google:agent');
  schedule.events.set('seminar',{id:'seminar',title:'Семинар',start:'2026-10-09T07:00:00Z',end:'2026-10-09T08:00:00Z'});
  const calendar=new StudyCalendar(schedule,agent);
  const t:Task={id:'hw_a',title:'ДЗ A',course:'Тестирование',status:'open',deadline:'2026-10-09T09:00:00Z',deadlineBasis:'explicit',sources:['tg:123:42'],disputed:false,notes:'Вычислить накоп'};
  await calendar.putTask(t);await calendar.putTask({...t,deadline:'2026-10-10T09:00:00Z',status:'done'});
  assert.equal(agent.events.size,1);assert.equal((await calendar.listTasks())[0]?.status,'done');
  assert.match(await calendar.lessonPreview('seminar'),/Семинар/);
  await calendar.changeLesson('seminar','2026-10-10T07:00:00Z','2026-10-10T08:00:00Z');
  assert.equal((await calendar.lessons('2026-10-09','2026-10-11'))[0]?.start,'2026-10-10T07:00:00.000Z');
  await calendar.putTask({...t,status:'cancelled'});assert.equal(agent.events.size,0);assert.equal(schedule.events.size,1);
  assert.throws(()=>new StudyCalendar(schedule,schedule));
});
test('CalDAV раскрывает недельные занятия по Москве, исключения и даты без времени; переносит один экземпляр, сохраняя серию и остальные поля',async()=>{
  const wire=davFixture(),url='https://caldav.icloud.com/schedule/weekly.ics';
  const weekly=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:weekly','DTSTAMP:20261001T000000Z','DTSTART;TZID=Europe/Moscow:20261007T100000','DTEND;TZID=Europe/Moscow:20261007T113000','RRULE:FREQ=WEEKLY;COUNT=4','EXDATE;TZID=Europe/Moscow:20261014T100000','SUMMARY:Семинар','LOCATION:Аудитория 42','DESCRIPTION:Не потерять описание','END:VEVENT','END:VCALENDAR'].join('\r\n');
  wire.objects.set(url,{url,data:weekly,etag:'0'});
  const floating='https://caldav.icloud.com/schedule/floating.ics';
  wire.objects.set(floating,{url:floating,data:['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:floating','DTSTART:20261009T100000','DTEND:20261009T110000','SUMMARY:Без зоны','END:VEVENT','END:VCALENDAR'].join('\r\n'),etag:'0'});
  const allDay='https://caldav.icloud.com/schedule/day.ics';
  wire.objects.set(allDay,{url:allDay,data:['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:day','DTSTART;VALUE=DATE:20261010','DTEND;VALUE=DATE:20261011','SUMMARY:Выходной','END:VEVENT','END:VCALENDAR'].join('\r\n'),etag:'0'});
  const backend=new CalDAVCollection(wire.client,{url:'https://caldav.icloud.com/schedule/'},'icloud:schedule');
  let lessons=await backend.range('2026-10-01T00:00:00Z','2026-11-01T00:00:00Z');
  assert.deepEqual(lessons.filter(e=>e.title==='Семинар').map(e=>e.start),['2026-10-07T07:00:00.000Z','2026-10-21T07:00:00.000Z','2026-10-28T07:00:00.000Z']);
  assert.equal(lessons.find(e=>e.title==='Без зоны')?.start,'2026-10-09T07:00:00.000Z');assert.equal(lessons.find(e=>e.allDay)?.start,'2026-10-10');
  const id=lessons.find(e=>e.start==='2026-10-21T07:00:00.000Z')!.id;
  await backend.move(id,'2026-10-22T07:00:00Z','2026-10-22T08:30:00Z');
  lessons=await backend.range('2026-10-01T00:00:00Z','2026-11-01T00:00:00Z');
  assert.deepEqual(lessons.filter(e=>e.title==='Семинар').map(e=>e.start),['2026-10-07T07:00:00.000Z','2026-10-22T07:00:00.000Z','2026-10-28T07:00:00.000Z']);
  assert.equal((await backend.get(id)).start,'2026-10-22T07:00:00.000Z');
  assert.match(wire.objects.get(url)!.data,/RRULE:FREQ=WEEKLY;COUNT=4/);assert.match(wire.objects.get(url)!.data,/LOCATION:Аудитория 42/);
});
