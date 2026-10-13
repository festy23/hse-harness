import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {Approvals,type ApprovalSender} from '../src/approvals.js';
import {StudyCalendar} from '../src/calendar/study-calendar.js';
import type {CalendarCollection,CalendarEvent} from '../src/calendar/collection.js';
const originalStart='2026-10-14T10:00:00+03:00',originalEnd='2026-10-14T11:30:00+03:00',desiredStart='2026-10-15T10:00:00+03:00',desiredEnd='2026-10-15T11:30:00+03:00';
async function fixture(run:(store:Store,messages:string[])=>Promise<void>){const folder=await mkdtemp(join(tmpdir(),'lesson-approvals-'));const store=new Store(folder);await store.load();try{await run(store,[]);}finally{await rm(folder,{recursive:true,force:true});}}
function lessonSender(){let start=originalStart,end=originalEnd;let writes=0,failResponse=false;const sender:ApprovalSender={question:async()=>'',previewLesson:async()=>`Семинар\nСейчас: ${start} → ${end}`,lessonMatches:async(_id,s,e)=>+new Date(s)===+new Date(start)&&+new Date(e)===+new Date(end),lesson:async(_id,s,e)=>{writes++;start=s;end=e;if(failResponse)throw Error('Move accepted, response lost');}};return {sender,get writes(){return writes;},get start(){return start;},edit(s:string,e:string){start=s;end=e;},loseResponse(){failResponse=true;}};}

test('stale lesson approval rejects a changed before-state and requires new consent without writing',()=>fixture(async(store,messages)=>{
  const wire=lessonSender();const approval=new Approvals(store,{send:async text=>{messages.push(text);}},wire.sender,new Set());
  const id=await approval.propose('lesson',{lessonId:'seminar',start:desiredStart,end:desiredEnd});wire.edit('2026-10-16T10:00:00+03:00','2026-10-16T11:30:00+03:00');
  await assert.rejects(()=>approval.decide(id,true),/новый черновик/);assert.equal(wire.writes,0);assert.equal(store.state.approvals[0]?.state,'rejected');assert.match(Object.values(store.state.notices)[0]!,/новое подтверждение/);
  const recovered=new Store(store.dir);await recovered.load();await new Approvals(recovered,{send:async()=>{}},wire.sender,new Set()).recover();assert.equal(wire.writes,0);
}));
test('accepted lesson move with lost response recovers sending approval via actual desired times without another write',()=>fixture(async(store,messages)=>{
  const wire=lessonSender();wire.loseResponse();const approval=new Approvals(store,{send:async text=>{messages.push(text);}},wire.sender,new Set());
  const id=await approval.propose('lesson',{lessonId:'seminar',start:desiredStart,end:desiredEnd});await assert.rejects(()=>approval.decide(id,true),/response lost/);assert.equal(wire.writes,1);assert.equal(store.state.approvals[0]?.state,'sending');
  const recovered=new Store(store.dir);await recovered.load();const resumed=new Approvals(recovered,{send:async()=>{}},wire.sender,new Set());await resumed.recover();await resumed.recover();assert.equal(wire.writes,1);assert.equal(recovered.state.approvals[0]?.state,'sent');
}));
test('lost-response lesson replay refuses a later external edit instead of restoring its previously accepted target',()=>fixture(async(store)=>{
  const wire=lessonSender();wire.loseResponse();const approval=new Approvals(store,{send:async()=>{}},wire.sender,new Set());const id=await approval.propose('lesson',{lessonId:'seminar',start:desiredStart,end:desiredEnd});await assert.rejects(()=>approval.decide(id,true));
  wire.edit('2026-10-16T10:00:00+03:00','2026-10-16T11:30:00+03:00');const recovered=new Store(store.dir);await recovered.load();await assert.rejects(()=>new Approvals(recovered,{send:async()=>{}},wire.sender,new Set()).recover(),/новый черновик/);assert.equal(wire.writes,1);assert.equal(recovered.state.approvals[0]?.state,'rejected');assert.match(wire.start,/16T/);
}));
test('actual StudyCalendar lessonMatches uses selected collection identity, normalized timezone and all-day boundaries',async()=>{
  let event:CalendarEvent={id:'ics.selected-occurrence',title:'Семинар',start:'2026-10-15T07:00:00.000Z',end:'2026-10-15T08:30:00.000Z',status:'confirmed'};
  const timetable={identity:'timetable',get:async(id:string)=>{assert.equal(id,event.id);return event;}} as CalendarCollection;
  const calendar=new StudyCalendar(timetable,{identity:'agent'} as CalendarCollection);
  assert.equal(await calendar.lessonMatches(event.id,desiredStart,desiredEnd),true);assert.equal(await calendar.lessonMatches(event.id,originalStart,originalEnd),false);
  event={...event,start:'2026-10-15',end:'2026-10-16',allDay:true};assert.equal(await calendar.lessonMatches(event.id,'2026-10-15T00:00:00+03:00','2026-10-16T00:00:00+03:00'),true);
  event.status='cancelled';assert.equal(await calendar.lessonMatches(event.id,desiredStart,desiredEnd),false);
});
