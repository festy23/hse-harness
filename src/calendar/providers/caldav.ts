import ICAL from 'ical.js';
import ical, { type VEvent,type DateWithTimeZone } from 'node-ical';
import type { DAVCalendar,DAVCalendarObject } from 'tsdav';
import { TZ,deadline,validateTask,type Task } from '../../domain.js';
import type { CalendarCollection,CalendarEvent } from '../collection.js';

export interface CalDAVTransport {
  fetchCalendarObjects(args:{calendar:DAVCalendar;objectUrls?:string[];urlFilter?:(url:string)=>boolean}):Promise<DAVCalendarObject[]>;
  createCalendarObject(args:{calendar:DAVCalendar;filename:string;iCalString:string;headers?:Record<string,string>}):Promise<Response>;
  updateCalendarObject(args:{calendarObject:DAVCalendarObject}):Promise<Response>;
  deleteCalendarObject(args:{calendarObject:DAVCalendarObject}):Promise<Response>;
}
type Component=InstanceType<typeof ICAL.Component>;
type ResourceId={url:string;recurrenceId?:string};
const encodeId=(id:ResourceId)=>`ics.${Buffer.from(JSON.stringify(id)).toString('base64url')}`;
function string(value:unknown):string {return typeof value==='object'&&value&&'val' in value?String(value.val):String(value??'');}
function stamp(date:DateWithTimeZone,allDay=false):string {
  return allDay?new Intl.DateTimeFormat('en-CA',{timeZone:date.tz??Intl.DateTimeFormat().resolvedOptions().timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date):date.toISOString();
}
/** Floating iCalendar times have no timezone; this personal assistant interprets them in Moscow. */
function normalized(root:Component):Component {
  const copy=new ICAL.Component(structuredClone(root.toJSON()));
  for(const event of copy.getAllSubcomponents('vevent'))for(const name of ['dtstart','dtend','recurrence-id','exdate','rdate'])for(const property of event.getAllProperties(name)){
    const time=property.getFirstValue();
    if(time instanceof ICAL.Time&&!time.isDate&&time.zone.tzid==='floating'&&!property.getParameter('tzid'))property.setParameter('tzid',TZ);
  }
  return copy;
}
function parsed(root:Component):VEvent {
  const events=Object.values(ical.sync.parseICS(normalized(root).toString())).filter((e):e is VEvent=>e?.type==='VEVENT');
  if(events.length!==1)throw new Error('CalDAV resource должен содержать одно семейство VEVENT с одним UID');
  return events[0]!;
}
function fromEvent(base:VEvent,id:ResourceId,component:Component,start=base.start,end=base.end??base.start):CalendarEvent {
  const meta=component.getFirstPropertyValue('x-hse-study-task');
  const allDay=base.datetype==='date';
  return {id:encodeId(id),title:string(base.summary)||'Занятие',description:string(base.description),start:stamp(start,allDay),end:stamp(end,allDay),allDay,
    status:base.status==='CANCELLED'?'cancelled':'confirmed',recurrence:base.rrule?.toString(),
    ...(meta?{task:validateTask(JSON.parse(Buffer.from(String(meta),'base64').toString('utf8')) as Task)}:{})};
}
function rootOf(data:unknown):Component {
  if(typeof data!=='string'||!data.trim())throw new Error('CalDAV не вернул содержимое события');
  const root=new ICAL.Component(ICAL.parse(data));
  if(root.name!=='vcalendar')throw new Error('CalDAV вернул некорректный iCalendar');
  return root;
}
function masterOf(root:Component):Component {
  const masters=root.getAllSubcomponents('vevent').filter(e=>!e.hasProperty('recurrence-id'));
  if(masters.length!==1)throw new Error('Не найдено однозначное основное событие');
  return masters[0]!;
}
function recurrenceInstant(root:Component,event:Component):string|undefined {
  const only=new ICAL.Component(structuredClone(root.toJSON()));only.removeAllSubcomponents('vevent');only.addSubcomponent(new ICAL.Component(structuredClone(event.toJSON())));
  const eventData=parsed(only),value=eventData.recurrenceid;
  return value?stamp(value,event.getFirstPropertyValue('recurrence-id') instanceof ICAL.Time&&(event.getFirstPropertyValue('recurrence-id') as ICAL.Time).isDate):undefined;
}
function dates(component:Component,start:string,end:string,allDay=false):void {
  component.removeAllProperties('dtstart');component.removeAllProperties('dtend');component.removeAllProperties('duration');
  if(allDay&&(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)))throw new Error('Для allDay нужны даты YYYY-MM-DD');
  component.addPropertyWithValue('dtstart',allDay?ICAL.Time.fromDateString(start):ICAL.Time.fromJSDate(new Date(start),true));
  component.addPropertyWithValue('dtend',allDay?ICAL.Time.fromDateString(end):ICAL.Time.fromJSDate(new Date(end),true));
  component.updatePropertyWithValue('dtstamp',ICAL.Time.fromJSDate(new Date(Date.now()),true));
  component.updatePropertyWithValue('last-modified',ICAL.Time.fromJSDate(new Date(Date.now()),true));
  component.updatePropertyWithValue('sequence',Number(component.getFirstPropertyValue('sequence')??0)+1);
}
function serialize(event:CalendarEvent):string {
  if(!event.start||!event.end)throw new Error('Для события нужны start/end');
  const root=new ICAL.Component('vcalendar');root.updatePropertyWithValue('version','2.0');root.updatePropertyWithValue('prodid','-//HSE Study Assistant//EN');
  const e=new ICAL.Component('vevent');root.addSubcomponent(e);
  e.updatePropertyWithValue('uid',`${event.id}@hse-study-assistant`);e.updatePropertyWithValue('summary',event.title);
  e.updatePropertyWithValue('description',event.description??'');e.updatePropertyWithValue('status',event.status==='cancelled'?'CANCELLED':'CONFIRMED');
  dates(e,event.start,event.end,event.allDay);
  if(event.task)e.updatePropertyWithValue('x-hse-study-task',Buffer.from(JSON.stringify(event.task)).toString('base64'));
  return root.toString();
}
function checked(response:Response):void {
  if(!response.ok)throw Object.assign(new Error(`CalDAV: HTTP ${response.status}${response.status===412?'; событие изменилось, перечитайте перед повтором':''}`),{status:response.status});
}
export class CalDAVCollection implements CalendarCollection {
  constructor(readonly client:CalDAVTransport,readonly calendar:DAVCalendar,readonly identity:string){}
  private resolve(id:string):ResourceId {
    const value:ResourceId=id.startsWith('ics.')?JSON.parse(Buffer.from(id.slice(4),'base64url').toString('utf8')):{url:new URL(`${encodeURIComponent(id)}.ics`,this.calendar.url).href};
    const url=new URL(value.url),base=new URL(this.calendar.url);
    if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname)||url.search||url.hash||url.username||url.password)throw new Error('Событие вне выбранного календаря');
    if(value.recurrenceId&&!Number.isFinite(+new Date(value.recurrenceId)))throw new Error('Некорректный recurrence id');
    return {...value,url:url.href};
  }
  private async objects(urls?:string[]){return this.client.fetchCalendarObjects({calendar:this.calendar,objectUrls:urls,urlFilter:()=>true});}
  // tsdav rejects a multiget 404 instead of returning an absent object. A complete,
  // validated collection snapshot distinguishes absence from a failed read.
  private async resource(url:string):Promise<DAVCalendarObject|undefined>{return (await this.objects()).find(o=>new URL(o.url,this.calendar.url).href===url);}
  async list():Promise<CalendarEvent[]> {
    return (await this.objects()).flatMap(o=>{
      const root=rootOf(o.data);if(!root.getAllSubcomponents('vevent').length)return [];
      return [fromEvent(parsed(root),{url:new URL(o.url,this.calendar.url).href},masterOf(root))];
    });
  }
  async range(from:string,to:string):Promise<CalendarEvent[]> {
    const out:CalendarEvent[]=[];
    for(const o of await this.objects()){
      const root=rootOf(o.data);if(!root.getAllSubcomponents('vevent').length)continue;
      const base=parsed(root),component=masterOf(root);
      for(const instance of ical.expandRecurringEvent(base,{from:new Date(from),to:new Date(+new Date(to)-1),expandOngoing:true})){
        if(instance.event.status==='CANCELLED')continue;
        const recurrenceId=base.rrule||base.rdate?stamp(instance.event.recurrenceid??instance.start,base.datetype==='date'):undefined;
        out.push(fromEvent(instance.event,{url:new URL(o.url,this.calendar.url).href,recurrenceId},component,instance.start,instance.end));
      }
    }
    return out.sort((a,b)=>+new Date(a.start!)-+new Date(b.start!));
  }
  async get(id:string):Promise<CalendarEvent>{
    const target=this.resolve(id),o=await this.resource(target.url);if(!o)throw new Error('CalDAV: событие не найдено');
    const root=rootOf(o.data),base=parsed(root),component=masterOf(root);
    if(!target.recurrenceId)return fromEvent(base,target,component);
    const override=Object.values(base.recurrences??{}).find(e=>e.recurrenceid&&stamp(e.recurrenceid as DateWithTimeZone,base.datetype==='date')===target.recurrenceId);
    if(override)return fromEvent(override as VEvent,target,component);
    const at=Date.parse(deadline(target.recurrenceId).value),allDay=base.datetype==='date';
    const instance=ical.expandRecurringEvent(base,{from:new Date(at-(allDay?86400_000:0)),to:new Date(at+(allDay?86400_000:1000))}).find(e=>allDay?stamp(e.start,true)===target.recurrenceId:+e.start===at);
    if(!instance)throw new Error('CalDAV: экземпляр занятия больше не существует');
    return fromEvent(instance.event,target,component,instance.start,instance.end);
  }
  async put(event:CalendarEvent):Promise<void>{
    const target=this.resolve(event.id),existing=await this.resource(target.url),data=serialize(event);
    if(existing){if(!existing.etag)throw new Error('CalDAV не вернул ETag; безопасная запись невозможна');checked(await this.client.updateCalendarObject({calendarObject:{...existing,data}}));}
    else checked(await this.client.createCalendarObject({calendar:this.calendar,filename:new URL(target.url).pathname.split('/').at(-1)!,iCalString:data,headers:{'If-None-Match':'*'}}));
  }
  async remove(id:string):Promise<void>{
    const target=this.resolve(id),existing=await this.resource(target.url);if(!existing)return;
    if(!existing.etag)throw new Error('CalDAV не вернул ETag; безопасное удаление невозможно');
    const response=await this.client.deleteCalendarObject({calendarObject:existing});if(response.status!==404)checked(response);
  }
  async move(id:string,start:string,end:string):Promise<void>{
    const target=this.resolve(id),existing=await this.resource(target.url);if(!existing)throw new Error('CalDAV: событие не найдено');
    if(!existing.etag)throw new Error('CalDAV не вернул ETag; безопасная запись невозможна');
    const root=rootOf(existing.data),master=masterOf(root);let component=master;
    if(target.recurrenceId){
      await this.get(id); // Reject nonexistent/excluded occurrences before creating an override.
      const override=root.getAllSubcomponents('vevent').find(e=>e.hasProperty('recurrence-id')&&recurrenceInstant(root,e)===target.recurrenceId);
      if(override){
        if(override.getFirstProperty('recurrence-id')?.getParameter('range'))throw new Error('Перенос RANGE-серии требует отдельного согласования');
        component=override;
      }else{
        component=new ICAL.Component(structuredClone(master.toJSON()));
        for(const name of ['rrule','rdate','exdate','recurrence-id'])component.removeAllProperties(name);
        component.addPropertyWithValue('recurrence-id',/^\d{4}-\d{2}-\d{2}$/.test(target.recurrenceId)?ICAL.Time.fromDateString(target.recurrenceId):ICAL.Time.fromJSDate(new Date(target.recurrenceId),true));root.addSubcomponent(component);
      }
    }else if(master.hasProperty('rrule')||master.hasProperty('rdate'))throw new Error('Выберите конкретный экземпляр занятия через get_schedule; перенос всей серии не согласован');
    dates(component,start,end);
    checked(await this.client.updateCalendarObject({calendarObject:{...existing,data:root.toString()}}));
  }
  async changes(){return {events:await this.list(),full:true};}
}
