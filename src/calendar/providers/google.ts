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
  const raw=props?.task??(props?.taskParts?Array.from({length:Number(props.taskParts)},(_,i)=>props[`task${i}`]??'').join(''):undefined);
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
  private async events(params:Record<string,string>={}):Promise<CalendarEvent[]> {
    const events:CalendarEvent[]=[];let page:string|undefined;
    do{
      const q=new URLSearchParams({...params,maxResults:'2500',...(page?{pageToken:page}:{})});
      const data=await this.api.request<{items?:GoogleEvent[];nextPageToken?:string}>(`${this.root()}?${q}`);
      events.push(...(data.items??[]).map(decode));page=data.nextPageToken;
    }while(page);
    return events;
  }
  list(){return this.events();}
  range(from:string,to:string){return this.events({timeMin:from,timeMax:to,singleEvents:'true',orderBy:'startTime'});}
  async get(id:string){return decode(await this.api.request<GoogleEvent>(this.path(id)));}
  async put(event:CalendarEvent):Promise<void> {
    const path=this.path(event.id),body=encode(event);
    try{await this.api.request(path,'PUT',body);}catch(e){
      if((e as {status:number}).status!==404)throw e;
      try{await this.api.request(this.root(),'POST',body);}catch(err){
        if((err as {status:number}).status!==409)throw err;
        await this.api.request(path,'PUT',body);
      }
    }
  }
  async remove(id:string):Promise<void>{try{await this.api.request(this.path(id),'DELETE');}catch(e){if(![404,410].includes((e as {status:number}).status))throw e;}}
  async move(id:string,start:string,end:string):Promise<void>{await this.api.request(this.path(id),'PATCH',{start:{dateTime:start,timeZone:TZ},end:{dateTime:end,timeZone:TZ}});}
  async changes(cursor?:string):Promise<CalendarChanges>{
    let token=cursor,page:string|undefined,retried=false;const events:CalendarEvent[]=[];
    while(true){
      const q=new URLSearchParams({showDeleted:'true',maxResults:'2500',...(token?{syncToken:token}:{}),...(page?{pageToken:page}:{})});
      let result:{items?:GoogleEvent[];nextPageToken?:string;nextSyncToken?:string};
      try{result=await this.api.request(`${this.root()}?${q}`);}catch(e){
        if((e as {status:number}).status===410&&!retried){token=undefined;page=undefined;events.length=0;retried=true;continue;}throw e;
      }
      events.push(...(result.items??[]).map(decode));page=result.nextPageToken;
      if(!page)return {events,cursor:result.nextSyncToken,full:!token};
    }
  }
}
