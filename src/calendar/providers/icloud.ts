import { createDAVClient,type DAVCalendar } from 'tsdav';
import { secret } from '../../config.js';
import { CalDAVCollection } from './caldav.js';

export function iCloudUrl(value:string):URL {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||!(url.hostname==='caldav.icloud.com'||/^[a-z0-9-]+-caldav\.icloud\.com$/i.test(url.hostname)))throw new Error('Нужен HTTPS URL календаря iCloud CalDAV');
  return url;
}
/** Discovery may redirect to an account shard. Follow only iCloud CalDAV hosts with credentials. */
export const iCloudFetch:typeof fetch=async(input,options)=>{
  let url=iCloudUrl(typeof input==='string'||input instanceof URL?String(input):input.url);
  for(let n=0;n<5;n++){
    const response=await fetch(url,{...options,redirect:'manual',signal:options?.signal??AbortSignal.timeout(30_000)});
    if(response.status>=300&&response.status<400){url=iCloudUrl(new URL(response.headers.get('location')??'',url).href);continue;}
    if(response.status>=400&&response.status!==404)throw new Error(`iCloud CalDAV: HTTP ${response.status}`);
    return response;
  }
  throw new Error('Слишком много перенаправлений iCloud CalDAV');
};
export class ICloudAccount {
  private client?:ReturnType<typeof createDAVClient>;
  private discovery?:Promise<DAVCalendar[]>;
  private connect():ReturnType<typeof createDAVClient>{
    return this.client??=createDAVClient({serverUrl:'https://caldav.icloud.com',credentials:{username:secret('ICLOUD_USERNAME'),password:secret('ICLOUD_APP_PASSWORD')},authMethod:'Basic',defaultAccountType:'caldav',fetch:iCloudFetch});
  }
  calendars():Promise<DAVCalendar[]>{return this.discovery??=this.connect().then(client=>client.fetchCalendars());}
  async collection(id:string):Promise<CalDAVCollection>{
    const url=iCloudUrl(id);if(!url.pathname.endsWith('/'))throw new Error('URL календаря должен заканчиваться /; скопируйте его из setup icloud');
    const calendar=(await this.calendars()).find(c=>iCloudUrl(c.url).href===url.href);
    if(!calendar)throw new Error('Выбранный календарь iCloud не найден среди доступных; выполните setup icloud');
    return new CalDAVCollection(await this.connect(),calendar,`icloud:${url.href}`);
  }
}
