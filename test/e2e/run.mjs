import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { CalDAVFixture } from './caldav-fixture.mjs';

// Agreed seams: input chats/mail/private bot -> real daemon/Pi/tools -> notifications/calendar/group.
// Fixtures replace external transports and model decisions, never study rules or application loops.
const provider=process.argv.find(a=>a.startsWith('--calendar='))?.split('=')[1]??'icloud';
const startupPending=process.argv.includes('--startup-pending');
assert.ok(['icloud','google','yandex'].includes(provider));
const root=resolve('data/e2e/latest',provider+(startupPending?'-startup':''));await rm(root,{recursive:true,force:true});
await mkdir(join(root,'secrets'),{recursive:true});
const report=[];let complete=false;
const original='2026-10-08T09:00:00.000Z';
const state={now:Date.parse('2026-10-04T09:00:00Z'),updates:[],notifications:[],group:[],calendar:new Map(),schedule:{id:'seminar',summary:'Семинар по тестированию',start:{dateTime:'2026-10-07T10:00:00+03:00'},end:{dateTime:'2026-10-07T11:30:00+03:00'}},tg:[],mail:[],pts:1,nextUpdate:1,modelDown:false,botDown:false,groupAmbiguous:false,requests:0};
const cloud=new CalDAVFixture(state);let googleRequests=0;
state.calendarDown=startupPending;state.subscriptionReady=!startupPending;
const tasks=new Map();
const groupAttempts=[];
const successfulTurns=[];
const base=(id,title,deadlines)=>({id,title,course:'Тестирование',status:'open',deadlines,basis:'explicit',sources:[`tg:-100123:${id}`],notes:'',disputed:false});
const a=base('hw_a','ДЗ A',[original]);
const b={...base('hw_b','ДЗ B',['2026-10-10']),basis:'personal-date-rule',sources:['mail:fixture-1']};
function source(text,plan,replyTo){state.tg.push({id:100+state.tg.length,date:'2026-10-04T09:00:00Z',text,plan,replyTo,pts:++state.pts});}
source('Тестирование: ДЗ A до 8 октября, 12:00.',[{name:'update_task',args:a}]);
source('Напоминаю про то же ДЗ A, срок прежний.',[{name:'update_task',args:a}]);
state.mail.push({uid:1,date:'2026-10-04T09:00:00Z',subject:'Тестирование: ДЗ B',text:'ДЗ B сдать 10 октября.'});
function contentText(m){return typeof m.content==='string'?m.content:m.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')??'';}
function model(messages){
  if(state.modelDown)return {content:[],error:'E2E simulated model unavailable'};
  const text=contentText(messages.findLast(m=>m.role==='user')??{});let plan=[];
  successfulTurns.push(text);
  if(text.includes('Контроль приоритета диалога.'))return {content:[{type:'text',text:'Приоритетный личный ответ.'}]};
  if(messages.at(-1)?.role==='toolResult'){
    if(text.includes('Перенеси семинар')&&messages.at(-1).toolName==='get_schedule'){
      const lesson=JSON.parse(contentText(messages.at(-1))).find(l=>l.title==='Семинар по тестированию');
      return {content:[{type:'toolCall',id:`fixture-${state.requests}-move`,name:'propose_lesson_change',arguments:{lessonId:lesson.id,start:'2026-10-08T10:00:00+03:00',end:'2026-10-08T11:30:00+03:00'}}]};
    }
    return {content:[{type:'text',text:text.includes('Утренняя сводка')?'Утренняя сводка тестового провайдера.':text.includes('Вечерняя сводка')?'Вечерняя сводка тестового провайдера.':'Обработано.'}]};
  }
  if(text.includes('Новые ДАННЫЕ')){
    const sources=JSON.parse(text.slice(text.indexOf('\n[')+1));
    for(const s of sources){
      if(s.kind==='telegram')plan.push(...(state.tg.findLast(m=>`tg:-100123:${m.id}`===s.id)?.plan??[]));
      if(s.kind==='mail')plan.push({name:'update_task',args:b});
    }
  }else if(text.includes('Сделал ДЗ A'))plan=[{name:'update_task',args:{...tasks.get('hw_a'),status:'done'}}];
  else if(text.includes('Сделал ДЗ C'))plan=[{name:'update_task',args:{...tasks.get('hw_c'),status:'done'}}];
  else if(text.includes('Сдал ДЗ A'))plan=[{name:'update_task',args:{...tasks.get('hw_a'),status:'submitted'}}];
  else if(text.includes('Уточни срок ДЗ'))plan=[{name:'propose_question',args:{chat:'-100123',text:`Привет! Есть ли дедлайн по ДЗ ${text.match(/ДЗ ([CDE])/)[1]}?`}}];
  else if(text.includes('Что помнишь про ДЗ A')){
    const entries=messages.filter(m=>m.role==='toolResult'&&m.toolName==='update_task').flatMap(m=>{try{return [JSON.parse(contentText(m)).task];}catch{return [];}});
    const remembered=entries.findLast(t=>t?.id==='hw_a');
    return {content:[{type:'text',text:remembered?`Из истории Pi: ДЗ A ${remembered.status}, ${remembered.deadline}`:'История потеряна'}]};
  }
  else if(text.includes('Перенеси семинар'))plan=[{name:'get_schedule',args:{from:'2026-10-01',to:'2026-10-20'}}];
  else if(text.includes('сводка'))plan=[{name:'list_tasks',args:{}},{name:'get_schedule',args:{from:'2026-10-04',to:'2026-10-20'}}];
  for(const p of plan)if(p.name==='update_task')tasks.set(p.args.id,p.args);
  return {content:plan.length?plan.map((p,i)=>({type:'toolCall',id:`fixture-${state.requests}-${i}`,name:p.name,arguments:p.args})):[{type:'text',text:'Ответ тестовой модели.'}]};
}
const server=createServer(async(req,res)=>{
  try{
    state.requests++;const url=new URL(req.url,'http://127.0.0.1');const chunks=[];for await(const c of req)chunks.push(c);
    const raw=Buffer.concat(chunks).toString();const body=url.pathname.startsWith('/icloud')?raw:chunks.length?JSON.parse(raw):{};
    res.setHeader('content-type','application/json');res.setHeader('x-test-now',String(state.now));
    const send=(data,status=200)=>{res.statusCode=status;res.end(JSON.stringify(data));};
    if(url.pathname.startsWith('/icloud')){if(state.calendarDown||(state.calendarObjectsDown&&req.method==='REPORT'))return send({},503);return cloud.handle(req,res,url,body);}
    if(url.pathname==='/runtime/auth')return send({ready:state.subscriptionReady});
    if(url.pathname==='/bot/getUpdates'){await pause(25);return send({ok:true,result:state.updates.filter(u=>u.update_id>=body.offset)});}
    if(url.pathname==='/bot/sendMessage'){
      if(state.botDown)return send({ok:false,description:'fixture offline'},503);
      state.notifications.push(body);return send({ok:true,result:{message_id:state.notifications.length}});
    }
    if(url.pathname==='/bot/answerCallbackQuery')return send({ok:true,result:true});
    if(url.pathname==='/tg/history')return send([...state.tg].reverse());
    if(url.pathname==='/tg/difference')return send({pts:state.pts,messages:state.tg.filter(m=>m.pts>body.pts)});
    if(url.pathname==='/tg/send'){
      groupAttempts.push(body);
      let message=state.group.find(m=>m.randomId===body.randomId);
      if(!message){message={...body,id:500+state.group.length};state.group.push(message);}
      if(state.groupAmbiguous){state.groupAmbiguous=false;return send({error:'Accepted then response lost'},503);}return send(message);
    }
    if(url.pathname==='/mail/list')return send(state.mail);
    if(url.pathname==='/model')return send(model(body.messages));
    if(url.pathname.startsWith('/google/')){
      googleRequests++;
      const [, , ,calendar, ,id]=url.pathname.split('/');
      if(calendar==='schedule'){
        if(req.method==='PATCH'){state.schedule={...state.schedule,...body};return send(state.schedule);}
        return send(id?state.schedule:{items:url.searchParams.has('syncToken')?[]:[state.schedule],nextSyncToken:'fixture-token'});
      }
      assert.equal(calendar,'agent');
      if(req.method==='GET')return send({items:[...state.calendar.values()]});
      if(req.method==='DELETE'){state.calendar.delete(id);res.statusCode=204;return res.end();}
      if(req.method==='PUT'&&!state.calendar.has(id))return send({},404);
      state.calendar.set(id??body.id,body);return send(body);
    }
    return send({error:'Unknown fixture route '+url.pathname},404);
  }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const endpoint=`http://127.0.0.1:${server.address().port}`;
const davHost=provider==='yandex'?'caldav.yandex.ru':'caldav.icloud.com';
await writeFile(join(root,'config.json'),JSON.stringify({ownerId:123,chats:[{id:'-100123',title:'Тестовая учебная группа'}],features:{googleCalendar:provider==='google',icloudCalendar:provider==='icloud',yandexCalendar:provider==='yandex'},calendars:{timetable:{provider,id:provider==='google'?'schedule':`https://${davHost}/calendars/user/schedule/`},agent:{provider,id:provider==='google'?'agent':`https://${davHost}/calendars/user/agent/`}},folders:['INBOX'],model:startupPending?'':'e2e-scripted',pollSeconds:15}));
await writeFile(join(root,'secrets/telegram.session'),'');
await writeFile(join(root,'secrets/google.json'),JSON.stringify({access_token:'fixture',refresh_token:'fixture',expires_at:Date.parse('2030-01-01')}));
let child,logs='',exited;
function start(){
  exited=false;child=spawn(process.execPath,['--import',resolve('test/e2e/preload.mjs'),resolve('dist/main.js')],{env:{...process.env,STUDY_CONFIG:join(root,'config.json'),STUDY_DATA_DIR:join(root,'runtime'),STUDY_SECRETS_DIR:join(root,'secrets'),STUDY_E2E_ENDPOINT:endpoint,TELEGRAM_BOT_TOKEN:'fixture',TELEGRAM_API_ID:'1',TELEGRAM_API_HASH:'fixture',YANDEX_ADDRESS:'fixture@example.test',YANDEX_APP_PASSWORD:'fixture',ICLOUD_USERNAME:'fixture@example.test',ICLOUD_APP_PASSWORD:'fixture',YANDEX_CALENDAR_USERNAME:'fixture@example.test',YANDEX_CALENDAR_APP_PASSWORD:'fixture'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',c=>{logs+=c;});child.stderr.on('data',c=>{logs+=c;});child.on('exit',()=>{exited=true;});
}
async function stop(){if(!child||exited)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');const result=await Promise.race([done.then(()=>true),pause(3000).then(()=>false)]);if(!result){child.kill('SIGKILL');await done;throw new Error('Daemon did not stop gracefully');}}
async function crash(){const done=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await done;}
async function until(fn,label,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(exited)throw new Error('Daemon exited:\n'+logs);if(await fn())return;await pause(25);}throw new Error('Timed out: '+label+'\n'+logs);}
function bot(text){state.updates.push({update_id:state.nextUpdate++,message:{message_id:state.nextUpdate,chat:{id:123,type:'private'},from:{id:123},text}});}
function callback(data,from=123,chat=123){state.updates.push({update_id:state.nextUpdate++,callback_query:{id:String(state.nextUpdate),from:{id:from},message:{chat:{id:chat,type:chat===123?'private':'supergroup'}},data}});}
const texts=()=>state.notifications.map(n=>n.text);
const taskEvents=()=>[...state.calendar.values()].map(e=>({event:e,task:e.task??JSON.parse(Array.from({length:Number(e.extendedProperties.private.taskParts)},(_,i)=>e.extendedProperties.private['task'+i]).join(''))}));
const event=id=>taskEvents().find(x=>x.task.id===id);
async function phase(label,fn){await fn();report.push(label);console.log(`PASS [${provider}] `+label);}
try{
  start();
  if(startupPending){
    await phase('Личный бот отвечает при недоступном календаре/отсутствии входа Pi, сохраняет сообщение и восстанавливается после настройки без рестарта',async()=>{
      bot('/start');await until(()=>texts().some(t=>t.startsWith('Это основной личный диалог')),'/start while calendar offline');
      state.calendarDown=false;
      await until(()=>texts().some(t=>t.startsWith('Модель: сейчас недоступен')),'missing Pi auth visible');
      const prior=state.notifications.length;bot('/status');
      await until(()=>texts().slice(prior).some(t=>t.startsWith('{')&&JSON.parse(t).starting===true),'startup status while Pi auth missing');
      bot('Привет, проверка очереди.');await until(()=>texts().some(t=>t.startsWith('Сообщение сохранено')),'message queued before initialization');
      const operations=JSON.parse(await readFile(join(root,'runtime/operations.json'),'utf8'));
      assert.ok(operations.queue.some(x=>x.ownerText==='Привет, проверка очереди.'));
      const configured=JSON.parse(await readFile(join(root,'config.json'),'utf8'));configured.model='e2e-scripted';
      await writeFile(join(root,'config.json'),JSON.stringify(configured));
      state.calendarObjectsDown=true; // Discovery succeeds, but reading events fails.
      state.subscriptionReady=true;
      await until(()=>texts().some(t=>t.startsWith('Учебный помощник запущен')),'recovered after subscription login');
      await until(()=>texts().some(t=>t==='Ответ тестовой модели.'),'queued owner message delivered after login');
      state.calendarObjectsDown=false;
      assert.equal(googleRequests,0);
    });
  }else{
  await phase('Первоначальная история Telegram + письмо: две работы, дубликат не создает третью, дата без часа = 00:00 Москвы',async()=>{
    await until(()=>texts().some(t=>t.includes('Первоначальный разбор завершен')),'initial review');
    assert.equal(state.calendar.size,2);assert.equal(event('hw_b').event.start.dateTime,'2026-10-09T21:00:00.000Z');
    assert.equal(texts().filter(t=>t.startsWith('До сдачи')).length,0);
    bot('/ready');await until(()=>texts().includes('Напоминания включены. Сообщай «сделал <задание>» и «сдал <задание>».'),'ready');
  });
  await phase('Напоминание за три дня приходит один раз; «сделал» сохраняет напоминания о сдаче',async()=>{
    state.now=Date.parse('2026-10-05T09:00:00Z');
    await until(()=>texts().some(t=>t.startsWith('До сдачи осталось три дня:')&&t.includes('ДЗ A')),'72h reminder');
    bot('Сделал ДЗ A.');await until(()=>event('hw_a')?.task.status==='done','done status');
    await pause(400);
    assert.equal(texts().filter(t=>t.startsWith('До сдачи')&&t.includes('ДЗ A')).length,1);
  });
  await phase('Конфликт сроков: ранняя дата, пометка спора, перенос без второго события и без старого таймера',async()=>{
    source('ДЗ A перенесено: в сообщениях 9 и 10 октября, 12:00.',[{name:'update_task',args:{...a,deadlines:['2026-10-10T12:00:00+03:00','2026-10-09T12:00:00+03:00'],disputed:true}}]);
    await until(()=>event('hw_a')?.task.deadline==='2026-10-09T09:00:00.000Z','moved conflict');
    await until(()=>texts().some(t=>t.startsWith('Изменение/близкий срок:')&&t.includes('ДЗ A')),'urgent move');
    assert.equal(state.calendar.size,2);assert.equal(event('hw_a').task.disputed,true);assert.equal(event('hw_a').task.status,'done');
    const prior=texts().filter(t=>t.startsWith('До сдачи')&&t.includes('ДЗ A')).length;
    state.now=Date.parse('2026-10-08T08:00:00Z');await pause(500);
    assert.equal(texts().filter(t=>t.startsWith('До сдачи')&&t.includes('ДЗ A')).length,prior);
  });
  await phase('Отмена убирает событие и напоминания; «сдал» не сбрасывается новым объявлением',async()=>{
    source('ДЗ B отменено.',[{name:'update_task',args:{...b,status:'cancelled'}}]);
    await until(()=>!event('hw_b'),'cancelled B');await until(()=>texts().some(t=>t.startsWith('Отмена:')&&t.includes('ДЗ B')),'cancel notice');
    bot('Сдал ДЗ A.');await until(()=>event('hw_a')?.task.status==='submitted','submitted A');
    source('Повтор объявления ДЗ A, 9 октября в 12:00.',[{name:'update_task',args:{...a,deadlines:['2026-10-09T12:00:00+03:00']}}]);
    await pause(600);assert.equal(event('hw_a').task.status,'submitted');
    const prior=texts().filter(t=>t.startsWith('До сдачи')).length;
    state.now=Date.parse('2026-10-09T08:00:00Z');await pause(500);
    assert.equal(texts().filter(t=>t.startsWith('До сдачи')).length,prior);
  });
  await phase('Вопрос в группе отправляется только после личного одобрения; чужие/групповые и повторные подтверждения не отправляют его',async()=>{
    bot('Уточни срок ДЗ C.');
    await until(()=>state.notifications.some(n=>n.reply_markup&&n.text.includes('ДЗ C')),'question draft');
    const draft=state.notifications.findLast(n=>n.reply_markup&&n.text.includes('ДЗ C'));
    const approve=draft.reply_markup.inline_keyboard[0][0].callback_data;
    assert.equal(state.group.length,0);
    callback(approve,456);callback(approve,123,-100123);await pause(250);assert.equal(state.group.length,0);
    callback(approve);callback(approve);await until(()=>state.group.length===1,'approved question');
    await pause(250);assert.equal(state.group.length,1);assert.equal(state.group[0].text,'Привет! Есть ли дедлайн по ДЗ C?');
  });
  await phase('Без ответа сутки: одно сообщение владельцу, без повторного вопроса; ответ на другой вопрос останавливает ожидание',async()=>{
    state.now=Date.parse('2026-10-10T08:00:01Z');
    await until(()=>texts().some(t=>t.startsWith('На вопрос')&&t.includes('ДЗ C')),'24h no response');
    await pause(300);assert.equal(texts().filter(t=>t.startsWith('На вопрос')&&t.includes('ДЗ C')).length,1);assert.equal(state.group.length,1);
    bot('Уточни срок ДЗ D.');await until(()=>state.notifications.some(n=>n.reply_markup&&n.text.includes('ДЗ D')),'second draft');
    const draft=state.notifications.findLast(n=>n.reply_markup&&n.text.includes('ДЗ D'));
    callback(draft.reply_markup.inline_keyboard[0][0].callback_data);await until(()=>state.group.length===2,'second question');
    source('Для ДЗ D срок пока не объявлен.',[],state.group[1].id);await pause(600);
    state.now=Date.parse('2026-10-11T08:00:02Z');await pause(500);
    assert.equal(texts().filter(t=>t.startsWith('На вопрос')&&t.includes('ДЗ D')).length,0);
  });
  await phase('Расписание изменяется только после одобрения показанного занятия; отклоненный черновик ничего не меняет',async()=>{
    bot('Перенеси семинар.');await until(()=>state.notifications.some(n=>n.reply_markup&&n.text.includes('Изменить занятие')),'lesson draft');
    let draft=state.notifications.findLast(n=>n.reply_markup&&n.text.includes('Изменить занятие'));
    assert.match(draft.text,/Семинар по тестированию/);assert.equal(state.schedule.start.dateTime,'2026-10-07T10:00:00+03:00');
    callback(draft.reply_markup.inline_keyboard[0][1].callback_data);await pause(250);
    assert.equal(state.schedule.start.dateTime,'2026-10-07T10:00:00+03:00');
    const prior=state.notifications.length;bot('Перенеси семинар.');
    await until(()=>state.notifications.slice(prior).some(n=>n.reply_markup&&n.text.includes('Изменить занятие')),'new lesson draft');
    draft=state.notifications.findLast(n=>n.reply_markup&&n.text.includes('Изменить занятие'));
    callback(draft.reply_markup.inline_keyboard[0][0].callback_data);
    await until(()=>state.schedule.start.dateTime==='2026-10-08T07:00:00.000Z','approved timetable move');
    assert.equal(event('hw_a').task.status,'submitted');
  });
  await phase('Перезапуск процесса сохраняет контекст штатной Pi-сессии и не повторяет напоминания/одобренные вопросы',async()=>{
    const priorReminders=texts().filter(t=>t.startsWith('До сдачи')).length;
    await stop();start();await until(()=>texts().filter(t=>t.startsWith('Учебный помощник запущен')).length===2,'daemon restarted');
    bot('Что помнишь про ДЗ A?');await until(()=>texts().some(t=>t.includes('Из истории Pi: ДЗ A submitted, 2026-10-09T09:00:00.000Z')),'Pi native history restored');
    await pause(400);assert.equal(state.group.length,2);assert.equal(texts().filter(t=>t.startsWith('До сдачи')).length,priorReminders);
  });
  await phase('Неоднозначный ответ Telegram после принятой отправки: восстановление не создает второго вопроса',async()=>{
    bot('Уточни срок ДЗ E.');await until(()=>state.notifications.some(n=>n.reply_markup&&n.text.includes('ДЗ E')),'ambiguous draft');
    const draft=state.notifications.findLast(n=>n.reply_markup&&n.text.includes('ДЗ E'));state.groupAmbiguous=true;
    const attempts=groupAttempts.length;
    callback(draft.reply_markup.inline_keyboard[0][0].callback_data);await until(()=>state.group.length===3,'accepted group message');
    await until(()=>groupAttempts.length>=attempts+2,'ambiguous send retried');
    assert.equal(groupAttempts[attempts].randomId,groupAttempts[attempts+1].randomId);assert.equal(state.group.length,3);
    callback(draft.reply_markup.inline_keyboard[0][0].callback_data);await pause(300);assert.equal(state.group.length,3);
  });
  const c=base('hw_c','ДЗ C',['2026-10-15T12:00:00+03:00']);
  const d=base('hw_d','ДЗ D',['2026-10-16T12:00:00+03:00']);
  await phase('Сбой модели сохраняет новые сообщения; известные напоминания работают, после рестарта очередь догоняется',async()=>{
    source('ДЗ C до 15 октября, 12:00.',[{name:'update_task',args:c}]);await until(()=>event('hw_c'),'task C before model outage');
    state.modelDown=true;source('ДЗ D до 16 октября, 12:00.',[{name:'update_task',args:d}]);
    await until(()=>texts().some(t=>t.startsWith('Модель: сейчас недоступен')),'model outage alert');assert.equal(event('hw_d'),undefined);
    bot('/status');await until(()=>texts().some(t=>t.startsWith('{')&&JSON.parse(t).queued>0),'visible pending queue');
    await until(async()=>JSON.parse(await readFile(join(root,'runtime/operations.json'),'utf8')).queue.some(x=>x.sources.some(s=>s.text.includes('ДЗ D до 16 октября'))),'source D persisted before owner');
    bot('Контроль приоритета диалога.');
    await until(async()=>JSON.parse(await readFile(join(root,'runtime/operations.json'),'utf8')).queue.some(x=>x.ownerText==='Контроль приоритета диалога.'),'owner behind pending sources');
    state.now=Date.parse('2026-10-12T09:00:00Z');
    await until(()=>texts().some(t=>t.startsWith('До сдачи осталось три дня:')&&t.includes('ДЗ C')),'reminder without model');
    const prior=texts().filter(t=>t.startsWith('До сдачи')&&t.includes('ДЗ C')).length;
    await stop();const turnStart=successfulTurns.length;state.modelDown=false;start();await until(()=>event('hw_d'),'recovered queued D');
    await until(()=>texts().includes('Приоритетный личный ответ.'),'owner answered through backlog');
    const recovered=successfulTurns.slice(turnStart);
    const ownerIndex=recovered.findIndex(t=>t.includes('Контроль приоритета диалога.')),sourceIndex=recovered.findIndex(t=>t.includes('ДЗ D до 16 октября'));
    assert.ok(ownerIndex>=0&&sourceIndex>=0&&ownerIndex<sourceIndex,'owner turn must precede the pending source turn');
    await pause(400);assert.equal(texts().filter(t=>t.startsWith('До сдачи')&&t.includes('ДЗ C')).length,prior);
  });
  await phase('Два переноса при сбое доставки и аварийный останов: после запуска приходит только актуальное уведомление',async()=>{
    state.botDown=true;
    source('ДЗ C перенесли на 17 октября.',[{name:'update_task',args:{...c,deadlines:['2026-10-17T12:00:00+03:00']}}]);
    await until(()=>event('hw_c')?.task.deadline==='2026-10-17T09:00:00.000Z','first undelivered move');
    source('ДЗ C окончательно перенесли на 18 октября.',[{name:'update_task',args:{...c,deadlines:['2026-10-18T12:00:00+03:00']}}]);
    await until(()=>event('hw_c')?.task.deadline==='2026-10-18T09:00:00.000Z','latest undelivered move');await pause(150);
    await crash();const prior=state.notifications.length;state.botDown=false;start();
    await until(()=>texts().slice(prior).some(t=>t.startsWith('Изменение/близкий срок:')&&t.includes('ДЗ C')),'recovered urgent notice');
    const notices=texts().slice(prior).filter(t=>t.startsWith('Изменение/близкий срок:')&&t.includes('ДЗ C'));
    assert.equal(notices.length,1);assert.match(notices[0],/18 окт/);assert.doesNotMatch(notices[0],/17 окт/);
  });
  await phase('Сводки в 10:00 и 20:00 Москвы отправляются по одной; выполненная работа напоминает о сдаче за сутки и час',async()=>{
    state.now=Date.parse('2026-10-13T07:00:00Z');await until(()=>texts().includes('Утренняя сводка тестового провайдера.'),'10 Moscow digest');
    state.now=Date.parse('2026-10-13T17:00:00Z');await until(()=>texts().includes('Вечерняя сводка тестового провайдера.'),'20 Moscow digest');
    await pause(300);assert.equal(texts().filter(t=>t==='Утренняя сводка тестового провайдера.').length,1);assert.equal(texts().filter(t=>t==='Вечерняя сводка тестового провайдера.').length,1);
    bot('Сделал ДЗ C.');await until(()=>event('hw_c')?.task.status==='done','C done');
    state.now=Date.parse('2026-10-17T09:00:00Z');await until(()=>texts().some(t=>t.startsWith('До сдачи осталось день:')&&t.includes('ДЗ C')&&t.includes('осталось сдать')),'done 24h reminder');
    state.now=Date.parse('2026-10-18T08:00:00Z');await until(()=>texts().some(t=>t.startsWith('До сдачи осталось час:')&&t.includes('ДЗ C')&&t.includes('осталось сдать')),'done 1h reminder');
  });
  await phase('После восстановления доставки /status показывает исправность уведомлений',async()=>{
    const prior=state.notifications.length;bot('/status');
    await until(()=>texts().slice(prior).some(t=>t.startsWith('{')&&JSON.parse(t).health['Уведомления/календарь']==='ok'),'notification health recovered',2000);
  });
  if(provider!=='google')assert.equal(googleRequests,0,'Disabled Google must never receive a request');
  }
  complete=true;
}finally{
  let cleanupError;await stop().catch(error=>{logs+='\n'+error;cleanupError=error;});
  server.closeAllConnections();await new Promise(r=>server.close(r));
  await writeFile(join(root,'daemon.log'),logs);
  await writeFile(join(root,'result.json'),JSON.stringify({success:complete&&!cleanupError,calendarProvider:provider,googleRequests,externalServices:'loopback fixtures',model:'scripted tool decisions, no real LLM',passed:report,notifications:state.notifications,group:state.group,groupAttempts},null,2));
  console.log(`Local artifacts: ${root}`);
  if(cleanupError)throw cleanupError;
}
