import { Type, type TSchema, type Static } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { convert } from 'html-to-text';
import { deadline, validateTask, hash, type Calendar, type Task } from './domain.js';
import type { Approvals } from './approvals.js';
import type { Notifier } from './bot.js';
import type { Scheduler } from './scheduler.js';
import type { Store } from './store.js';
import type { PiAssistant } from './pi.js';
import type { TelegramSource } from './telegram.js';

function tool<T extends TSchema>(name:string,description:string,parameters:T,fn:(args:Static<T>)=>Promise<unknown>):ToolDefinition<T> {
  return {name,label:name,description,parameters,executionMode:'sequential',async execute(_id,args) {
    const result=await fn(args);return {content:[{type:'text',text:JSON.stringify(result)}],details:{}};
  }};
}
export function hseUrl(value:string):URL {
  const url=new URL(value);
  if(url.protocol!=='https:' || url.username || url.password || url.port || !/^(?:[a-z0-9-]+\.)*hse\.ru$/i.test(url.hostname)) throw new Error('Разрешены только HTTPS страницы hse.ru');
  return url;
}
export async function readHse(value:string,offset=0):Promise<unknown> {
  let url=hseUrl(value);
  for(let i=0;i<5;i++) {
    const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(20_000)});
    if(r.status>=300 && r.status<400) {url=hseUrl(new URL(r.headers.get('location')??'',url).href);continue;}
    if(!r.ok) throw new Error(`HSE: HTTP ${r.status}`);
    if(!/text\//i.test(r.headers.get('content-type')??'')) throw new Error('Страница не текстовая; правило остается непроверенным');
    const reader=r.body!.getReader();let size=0;const chunks:Uint8Array[]=[];
    try {while(true) {const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1_000_000) throw new Error('Слишком большая страница');chunks.push(value);}} finally {await reader.cancel();}
    const html=Buffer.concat(chunks).toString('utf8');
    const links=[...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].flatMap(m=>{try {return [hseUrl(new URL(m[1]!,url).href).href];}catch{return [];}});
    const text=convert(html,{wordwrap:false,baseElements:{selectors:['body']}});
    return {url:url.href,text:text.slice(offset,offset+25_000),totalCharacters:text.length,nextOffset:offset+25_000<text.length?offset+25_000:undefined,links:[...new Set(links)].slice(0,200)};
  }
  throw new Error('Слишком много перенаправлений HSE');
}
export function studyTools(d:{calendar:Calendar;approvals:Approvals;bot:Notifier;scheduler:Scheduler;store:Store;pi:PiAssistant;telegram:TelegramSource}):ToolDefinition[] {
  return [
    tool('list_tasks','Текущие работы из календаря агента; неизвестные сроки ищи в истории Pi.',Type.Object({}),async()=>d.calendar.listTasks()),
    tool('update_task','Создай/обнови одно обязательство с устойчивым id, источниками и статусом. При конфликте передай все даты, выбирается ранняя.',Type.Object({
      id:Type.String({pattern:'^[a-z0-9_-]{1,80}$'}),title:Type.String({minLength:1,maxLength:250}),course:Type.String({minLength:1,maxLength:150}),
      status:Type.Union(['open','done','submitted','cancelled'].map(x=>Type.Literal(x))),
      deadlines:Type.Array(Type.String(),{maxItems:10}),basis:Type.Union(['explicit','personal-date-rule','schedule','unknown'].map(x=>Type.Literal(x))),
      sources:Type.Array(Type.String({maxLength:500}),{minItems:1,maxItems:20}),notes:Type.String({maxLength:3000}),disputed:Type.Boolean(),
    }),async a=>{
      const normalized=a.deadlines.map(deadline).sort((x,y)=>+new Date(x.value)-+new Date(y.value));
      let t=validateTask({id:a.id,title:a.title,course:a.course,status:a.status as Task['status'],deadline:normalized[0]?.value,
        deadlineBasis:normalized[0]?.basis==='personal-date-rule'?'personal-date-rule':a.basis as Task['deadlineBasis'],sources:a.sources,notes:a.notes,disputed:a.disputed||new Set(normalized.map(x=>x.value)).size>1});
      await d.scheduler.transaction(async()=>{
        const previous=(await d.calendar.listTasks()).find(x=>x.id===t.id);
        if(['done','submitted'].includes(t.status) && previous?.status!==t.status && !d.pi.ownerTurn) throw new Error('Личный статус может менять только владелец в своем диалоге');
        if(!d.pi.ownerTurn && previous && ['done','submitted'].includes(previous.status) && t.status==='open')t={...t,status:previous.status};
        await d.calendar.putTask(t);await d.scheduler.sync(await d.calendar.listTasks());
        if(d.store.state.bootstrapFinished) await d.scheduler.urgent(t,previous);
      });
      return {task:t,calendarUpdated:Boolean(t.deadline)||t.status==='cancelled'};
    }),
    tool('get_schedule','Занятия из календаря расписания в указанный период.',Type.Object({from:Type.String(),to:Type.String()}),async a=>{
      const from=deadline(a.from).value,to=deadline(a.to).value;
      if(+new Date(to)<=+new Date(from)||+new Date(to)-+new Date(from)>31*86400_000)throw new Error('Допустим период до 31 дня');
      return d.calendar.lessons(from,to);
    }),
    tool('propose_question','Подготовь конкретный вопрос в разрешенный чат; сервис запросит одобрение. Сам инструмент не отправляет в группу.',Type.Object({chat:Type.String(),text:Type.String({minLength:1,maxLength:3500})}),async a=>({draft:await d.approvals.propose('question',a)})),
    tool('propose_lesson_change','Запроси одобрение изменения занятия в исходном расписании.',Type.Object({lessonId:Type.String(),start:Type.String(),end:Type.String()}),async a=>({draft:await d.approvals.propose('lesson',{lessonId:a.lessonId,start:deadline(a.start).value,end:deadline(a.end).value})})),
    tool('notify_owner','Личное важное уведомление владельцу. Не использовать вместо финального ответа на его вопрос.',Type.Object({text:Type.String({minLength:1,maxLength:3500})}),async a=>{
      const key=`notice:${d.pi.turnId}:${hash(a.text)}`;
      if(!d.store.state.delivered[key]){await d.bot.send(a.text);d.store.state.delivered[key]=Date.now();await d.store.save();}
      return {sent:true};
    }),
    tool('read_chat_history','Контекст только разрешенного чата, включая исходные авторов/ответы.',Type.Object({chat:Type.String(),limit:Type.Integer({minimum:1,maximum:100})}),async a=>d.telegram.history(a.chat,a.limit)),
    tool('search_history','Поиск по оригинальным записям штатной Pi-сессии, сохраненным до compaction.',Type.Object({query:Type.String({minLength:2,maxLength:150})}),async a=>d.pi.search(a.query)),
    tool('read_hse','Читай официальную текстовую страницу hse.ru. При nextOffset дочитай страницу с этим offset; иначе можно пропустить формулу. Возвращает ссылки каталога/предметов.',Type.Object({url:Type.String(),offset:Type.Optional(Type.Integer({minimum:0,maximum:1_000_000}))}),async a=>readHse(a.url,a.offset)),
  ];
}
