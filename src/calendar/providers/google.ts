import {budgets,withOperation,OperationError,type OperationContext} from '../../operations.js';
import { Google } from '../../google.js';
import { TZ,validateTask,type Task } from '../../domain.js';
import type { CalendarChanges,CalendarCollection,CalendarEvent } from '../collection.js';

interface GoogleEvent {
  id:string;summary?:string;description?:string;status?:string;recurrence?:string[];
  start?:{dateTime?:string;date?:string;timeZone?:string};end?:{dateTime?:string;date?:string;timeZone?:string};
  extendedProperties?:{private?:Record<string,string>};
}
function decode(e:GoogleEvent):CalendarEvent {
  const props=e.extendedProperties?.private;
  const parts=Number(props?.taskParts??0);if(!Number.isSafeInteger(parts)||parts<0||parts>32)throw new OperationError('payload-limit','Некорректные метаданные задания');
  const raw=props?.task??(parts?Array.from({length:parts},(_,i)=>props![`task${i}`]??'').join(''):undefined);
  return {id:e.id,title:e.summary??'Занятие',description:e.description,start:e.start?.dateTime??e.start?.date,end:e.end?.dateTime??e.end?.date,
    allDay:Boolean(e.start?.date),status:e.status==='cancelled'?'cancelled':'confirmed',recurrence:e.recurrence?.join('\n'),
    ...(raw?{task:validateTask(JSON.parse(raw) as Task)}:{})};
}
function encode(e:CalendarEvent):GoogleEvent {
  const props:Record<string,string>={};
  if(e.task){
    props.studyAssistant='1';const parts:string[]=[];let part='';
    for(const ch of JSON.stringify(e.task)){if(Buffer.byteLength(part+ch)>900){parts.push(part);part='';}part+=ch;}
    if(part)parts.push(part);props.taskParts=String(parts.length);parts.forEach((p,i)=>{props[`task${i}`]=p;});
  }
  return {id:e.id,summary:e.title,description:e.description,status:e.status??'confirmed',
    ...(e.start?{start:e.allDay?{date:e.start}:{dateTime:e.start,timeZone:TZ}}:{}),
    ...(e.end?{end:e.allDay?{date:e.end}:{dateTime:e.end,timeZone:TZ}}:{}),
    ...(e.task?{extendedProperties:{private:props},reminders:{useDefault:false}}:{})};
}
export class GoogleCollection implements CalendarCollection {
  readonly identity:string;
  constructor(readonly api:Google,readonly id:string){this.identity=`google:${id}`;}
  private root(){return `calendars/${encodeURIComponent(this.id)}/events`;}
  private path(id:string){return `${this.root()}/${encodeURIComponent(id)}`;}
  private async events(params:Record<string,string>={},ctx?:OperationContext):Promise<CalendarEvent[]> {
    return withOperation('source',budgets.calendarScan,ctx,async op=>{
    const events:CalendarEvent[]=[];let page:string|undefined;const pages=new Set<string>();
    do{
      const q=new URLSearchParams({...params,maxResults:'2500',...(page?{pageToken:page}:{})});
      const data=await this.api.request<{items?:GoogleEvent[];nextPageToken?:string}>(`${this.root()}?${q}`,'GET',undefined,op);
      events.push(...(data.items??[]).map(decode));page=data.nextPageToken;if(page&&pages.has(page))throw new OperationError('protocol','Календарь повторил страницу');if(page)pages.add(page);if(events.length>20_000)throw new OperationError('payload-limit','Слишком много событий календаря');
    }while(page);
    return events;
    });
  }
  list(ctx?:OperationContext){return this.events({},ctx);}
  range(from:string,to:string,ctx?:OperationContext){return this.events({timeMin:from,timeMax:to,singleEvents:'true',orderBy:'startTime'},ctx);}
  async get(id:string,ctx?:OperationContext){return decode(await this.api.request<GoogleEvent>(this.path(id),'GET',undefined,ctx));}
  async put(event:CalendarEvent,ctx?:OperationContext):Promise<void> {
    return withOperation('tool',budgets.calendarMutation,ctx,async op=>{
    const path=this.path(event.id),body=encode(event);
    try{await this.api.request(path,'PUT',body,op);}catch(e){
      if((e as {status:number}).status!==404)throw e;
      try{await this.api.request(this.root(),'POST',body,op);}catch(err){
        if((err as {status:number}).status!==409)throw err;
        await this.api.request(path,'PUT',body,op);
      }
    }
    });
  }
  async remove(id:string,ctx?:OperationContext):Promise<void>{try{await this.api.request(this.path(id),'DELETE',undefined,ctx);}catch(e){if(![404,410].includes((e as {status:number}).status))throw e;}}
  async move(id:string,start:string,end:string,ctx?:OperationContext):Promise<void>{await this.api.request(this.path(id),'PATCH',{start:{dateTime:start,timeZone:TZ},end:{dateTime:end,timeZone:TZ}},ctx);}
  async changes(cursor?:string,ctx?:OperationContext):Promise<CalendarChanges>{
    return withOperation('source',budgets.calendarScan,ctx,async op=>{
    let token=cursor,page:string|undefined,retried=false;const events:CalendarEvent[]=[];const pages=new Set<string>();
    while(true){
      const q=new URLSearchParams({showDeleted:'true',maxResults:'2500',...(token?{syncToken:token}:{}),...(page?{pageToken:page}:{})});
      let result:{items?:GoogleEvent[];nextPageToken?:string;nextSyncToken?:string};
      try{result=await this.api.request(`${this.root()}?${q}`,'GET',undefined,op);}catch(e){
        if((e as {status:number}).status===410&&!retried){token=undefined;page=undefined;events.length=0;pages.clear();retried=true;continue;}throw e;
      }
      events.push(...(result.items??[]).map(decode));page=result.nextPageToken;if(page&&pages.has(page))throw new OperationError('protocol','Календарь повторил страницу');if(page)pages.add(page);if(events.length>20_000)throw new OperationError('payload-limit','Слишком много событий календаря');
      if(!page)return {events,cursor:result.nextSyncToken,full:!token};
    }
    });
  }
}
