import { createDAVClient,type DAVCalendar } from 'tsdav';
import { secret } from '../../config.js';
import { CalDAVCollection } from './caldav.js';

export function yandexUrl(value:string):URL {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='caldav.yandex.ru'||url.port||url.username||url.password||url.search||url.hash)throw new Error('Нужен HTTPS URL календаря caldav.yandex.ru');
  return url;
}
export const yandexFetch:typeof fetch=async(input,options)=>{
  let url=yandexUrl(typeof input==='string'||input instanceof URL?String(input):input.url);
  for(let n=0;n<5;n++){
    const response=await fetch(url,{...options,redirect:'manual',signal:options?.signal??AbortSignal.timeout(30_000)});
    if(response.status>=300&&response.status<400){url=yandexUrl(new URL(response.headers.get('location')??'',url).href);continue;}
    if(response.status>=400&&response.status!==404)throw new Error(`Яндекс CalDAV: HTTP ${response.status}`);
    return response;
  }
  throw new Error('Слишком много перенаправлений Яндекс CalDAV');
};
export class YandexAccount {
  private client?:ReturnType<typeof createDAVClient>;
  private discovery?:Promise<DAVCalendar[]>;
  private connect():ReturnType<typeof createDAVClient>{
    return this.client??=createDAVClient({serverUrl:'https://caldav.yandex.ru',credentials:{username:secret('YANDEX_CALENDAR_USERNAME'),password:secret('YANDEX_CALENDAR_APP_PASSWORD')},authMethod:'Basic',defaultAccountType:'caldav',fetch:yandexFetch});
  }
  calendars():Promise<DAVCalendar[]>{return this.discovery??=this.connect().then(client=>client.fetchCalendars());}
  async collection(id:string):Promise<CalDAVCollection>{
    const url=yandexUrl(id);
    if(!url.pathname.endsWith('/'))throw new Error('Скопируйте URL Яндекс-календаря через HSE HARNESS');
    const calendar=(await this.calendars()).find(c=>yandexUrl(c.url).href===url.href);
    if(!calendar)throw new Error('Выбранный Яндекс-календарь не найден; повторите выбор в HSE HARNESS');
    return new CalDAVCollection(await this.connect(),calendar,`yandex:${url.href}`);
  }
}
