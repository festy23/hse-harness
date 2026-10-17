import type {DAVCalendar,DAVCalendarObject} from 'tsdav';
import type {CalendarCollection,CalendarEvent} from '../collection.js';
import type {ResourceId} from '../compute.js';
import {runCompute} from '../../compute/index.js';
import {budgets,withOperation,OperationError,type OperationContext} from '../../operations.js';
export interface CalDAVTransport {
  fetchCalendarObjects(args:{calendar:DAVCalendar;objectUrls?:string[];urlFilter?:(url:string)=>boolean;fetchOptions?:RequestInit}):Promise<DAVCalendarObject[]>;
  createCalendarObject(args:{calendar:DAVCalendar;filename:string;iCalString:string;headers?:Record<string,string>;fetchOptions?:RequestInit}):Promise<Response>;
  updateCalendarObject(args:{calendarObject:DAVCalendarObject;fetchOptions?:RequestInit}):Promise<Response>;
  deleteCalendarObject(args:{calendarObject:DAVCalendarObject;fetchOptions?:RequestInit}):Promise<Response>;
}
async function checked(response:Response):Promise<void> {
  await response.body?.cancel();
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
  private async objects(ctx:OperationContext,urls?:string[]){
    const base=new URL(this.calendar.url);
    // iCloud can include the collection itself in calendar-query results. It
    // cannot be fetched as VEVENT data; event resources may lack an .ics suffix.
    return this.client.fetchCalendarObjects({calendar:this.calendar,objectUrls:urls,fetchOptions:{signal:ctx.signal},urlFilter:value=>{
      try{
        const url=new URL(value,base);
        return url.origin===base.origin&&url.pathname.startsWith(base.pathname)&&url.pathname!==base.pathname&&!url.pathname.endsWith('/')&&!url.search&&!url.hash&&!url.username&&!url.password;
      }catch{return false;}
    }});
  }
  // tsdav rejects a multiget 404 instead of returning an absent object. A complete,
  // validated collection snapshot distinguishes absence from a failed read.
  private async resource(url:string,ctx:OperationContext):Promise<DAVCalendarObject|undefined>{return (await this.objects(ctx)).find(o=>new URL(o.url,this.calendar.url).href===url);}
  async list(ctx?:OperationContext):Promise<CalendarEvent[]> {
    return this.read(undefined,undefined,ctx);
  }
  async range(from:string,to:string,ctx?:OperationContext):Promise<CalendarEvent[]> {
    return this.read(from,to,ctx);
  }
  private read(from:string|undefined,to:string|undefined,ctx?:OperationContext):Promise<CalendarEvent[]> {
    return withOperation('source',budgets.calendarScan,ctx,async op=>{
      const result:CalendarEvent[]=[];
      for(const object of await this.objects(op)){
        op.throwIfAborted();
        result.push(...await runCompute<CalendarEvent[]>({type:'calendar',action:from?'range':'list',data:object.data,url:new URL(object.url,this.calendar.url).href,from,to},op));
        if(result.length>20_000)throw new OperationError('payload-limit','Слишком много событий календаря');
      }
      return result.sort((a,b)=>+new Date(a.start!)-+new Date(b.start!));
    });
  }
  async get(id:string,ctx?:OperationContext):Promise<CalendarEvent>{
    return withOperation('tool',budgets.calendarScan,ctx,async op=>{
      const target=this.resolve(id),object=await this.resource(target.url,op);if(!object)throw new Error('CalDAV: событие не найдено');
      return runCompute<CalendarEvent>({type:'calendar',action:'get',data:object.data,id:target},op);
    });
  }
  async put(event:CalendarEvent,ctx?:OperationContext):Promise<void>{
    return withOperation('tool',budgets.calendarMutation,ctx,async op=>{
      const target=this.resolve(event.id),existing=await this.resource(target.url,op);
      const data=await runCompute<string>({type:'calendar',action:'serialize',event},op);op.throwIfAborted();
      if(existing){if(!existing.etag)throw new Error('CalDAV не вернул ETag; безопасная запись невозможна');await checked(await this.client.updateCalendarObject({calendarObject:{...existing,data},fetchOptions:{signal:op.signal}}));}
      else await checked(await this.client.createCalendarObject({calendar:this.calendar,filename:new URL(target.url).pathname.split('/').at(-1)!,iCalString:data,headers:{'If-None-Match':'*'},fetchOptions:{signal:op.signal}}));
    });
  }
  async remove(id:string,ctx?:OperationContext):Promise<void>{
    return withOperation('tool',budgets.calendarMutation,ctx,async op=>{
      const target=this.resolve(id),existing=await this.resource(target.url,op);if(!existing)return;
      if(!existing.etag)throw new Error('CalDAV не вернул ETag; безопасное удаление невозможно');
      const response=await this.client.deleteCalendarObject({calendarObject:existing,fetchOptions:{signal:op.signal}});if(response.status!==404)await checked(response);else await response.body?.cancel();
    });
  }
  async move(id:string,start:string,end:string,ctx?:OperationContext):Promise<void>{
    return withOperation('tool',budgets.calendarMutation,ctx,async op=>{
      const target=this.resolve(id),existing=await this.resource(target.url,op);if(!existing)throw new Error('CalDAV: событие не найдено');
      if(!existing.etag)throw new Error('CalDAV не вернул ETag; безопасная запись невозможна');
      const data=await runCompute<string>({type:'calendar',action:'move',id:target,data:existing.data,start,end},op);op.throwIfAborted();
      await checked(await this.client.updateCalendarObject({calendarObject:{...existing,data},fetchOptions:{signal:op.signal}}));
    });
  }
  async changes(_cursor?:string,ctx?:OperationContext){return {events:await this.list(ctx),full:true};}
}
