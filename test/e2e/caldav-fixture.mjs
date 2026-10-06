import ICAL from 'ical.js';
import assert from 'node:assert/strict';

const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const response=(href,props)=>`<d:response><d:href>${xml(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const cloud='https://caldav.icloud.com';
export class CalDAVFixture {
  constructor(state){
    this.state=state;this.resources=new Map();this.revision=1;
    const root=new ICAL.Component('vcalendar');root.updatePropertyWithValue('version','2.0');root.updatePropertyWithValue('prodid','-//E2E fixture//EN');
    const e=new ICAL.Component('vevent');root.addSubcomponent(e);e.updatePropertyWithValue('uid','seminar');e.updatePropertyWithValue('summary',state.schedule.summary);e.updatePropertyWithValue('dtstamp',ICAL.Time.fromJSDate(new Date('2026-10-01T00:00:00Z'),true));
    e.updatePropertyWithValue('dtstart',ICAL.Time.fromJSDate(new Date(state.schedule.start.dateTime),true));e.updatePropertyWithValue('dtend',ICAL.Time.fromJSDate(new Date(state.schedule.end.dateTime),true));
    this.resources.set('/calendars/user/schedule/seminar.ics',{data:root.toString(),etag:'"initial"'});
  }
  handle(req,res,url,body){
    const path=url.pathname.slice('/icloud'.length)||'/';
    const send=(value,status=207)=>{res.statusCode=status;res.setHeader('content-type','application/xml');res.end(value);};
    const multistatus=entries=>send(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${entries.join('')}</d:multistatus>`);
    const props=name=>`<d:displayname>${name}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><d:supported-report-set><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report><d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report></d:supported-report-set>`;
    if(req.method==='PROPFIND'){
      if(path==='/calendars/user/')return multistatus([response('/calendars/user/schedule/',props('Расписание')),response('/calendars/user/agent/',props('Учебный ассистент'))]);
      const discovery='<d:current-user-principal><d:href>/principal/</d:href></d:current-user-principal><c:calendar-home-set><d:href>/calendars/user/</d:href></c:calendar-home-set>';
      return multistatus([response(path,discovery+(path.includes('/calendars/')?props('Календарь'):''))]);
    }
    if(req.method==='GET')return send('',404);
    if(req.method==='REPORT'){
      const requested=[...body.matchAll(/<(?:\w+:)?href[^>]*>(.*?)<\/(?:\w+:)?href>/gs)].map(m=>new URL(m[1].replaceAll('&amp;','&'),cloud).pathname);
      const resources=requested.length?requested:[...this.resources.keys()].filter(p=>p.startsWith(path));
      return multistatus(resources.map(p=>{
        const o=this.resources.get(p);if(!o)return `<d:response><d:href>${xml(p)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
        return response(p,`<d:getetag>${xml(o.etag)}</d:getetag><c:calendar-data>${xml(o.data)}</c:calendar-data>`);
      }));
    }
    if(req.method==='PUT'){
      const previous=this.resources.get(path);
      if(previous)assert.ok(req.headers['if-match'],'Updates must carry the fetched ETag');
      else assert.equal(req.headers['if-none-match'],'*','Creation must be conditional');
      if(req.headers['if-none-match']==='*'&&previous||req.headers['if-match']&&previous?.etag!==req.headers['if-match'])return send('',412);
      this.resources.set(path,{data:body,etag:`"r${this.revision++}"`});
      const root=new ICAL.Component(ICAL.parse(body)),e=root.getFirstSubcomponent('vevent');
      const meta=e.getFirstPropertyValue('x-hse-study-task');
      const projection={id:path.split('/').at(-1),summary:String(e.getFirstPropertyValue('summary')),start:{dateTime:e.getFirstPropertyValue('dtstart').toJSDate().toISOString()},end:{dateTime:e.getFirstPropertyValue('dtend').toJSDate().toISOString()}};
      if(path.includes('/agent/')){projection.task=JSON.parse(Buffer.from(String(meta),'base64').toString());this.state.calendar.set(path,projection);}
      else if(path.includes('/schedule/'))this.state.schedule=projection;
      return send('',previous?204:201);
    }
    if(req.method==='DELETE'){
      if(this.resources.get(path)?.etag!==req.headers['if-match'])return send('',412);
      this.resources.delete(path);this.state.calendar.delete(path);return send('',204);
    }
    return send('',405);
  }
}
