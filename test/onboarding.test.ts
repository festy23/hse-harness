import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { Onboarding,SetupState,upsertEnv,type SetupConnections,type SetupUI } from '../src/onboarding.js';
import { legacyProfile,calendarSettings } from '../src/config.js';
import { studyInstructions } from '../src/pi.js';
import { yandexUrl,yandexFetch } from '../src/calendar/providers/yandex.js';

test('CLI сохраняет все шаги, выбирает разные провайдеры, ownerId автоматически и сохраняет существующие настройки',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hse-onboarding-'));
  const vars=['TELEGRAM_BOT_TOKEN','TELEGRAM_API_ID','TELEGRAM_API_HASH','YANDEX_ADDRESS','YANDEX_APP_PASSWORD','YANDEX_CALENDAR_USERNAME','YANDEX_CALENDAR_APP_PASSWORD','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'];
  const before=Object.fromEntries(vars.map(v=>[v,process.env[v]]));for(const v of vars)delete process.env[v];
  try{
    const state=new SetupState(dir,join(dir,'.env'),join(dir,'config.json'));await state.load();state.config.pollSeconds=90;await state.save();
    const inputs=['Анна','ВШЭ','ПМИ','БПМИ251','2','2026/27','Алгебра, анализ','НИС','bot-secret','123','api-secret','student@yandex.ru','mail-secret','google-client','google-secret','student@yandex.ru','calendar-secret'];
    const selections=['actual-model','google','yandex','schedule','deadlines'];
    const multi=[['-1002'],['INBOX']];const notes:string[]=[];const hidden:string[]=[];const called:string[]=[];
    const ui:SetupUI={
      async input({message,secret,validate}){const value=inputs.shift();assert.notEqual(value,undefined,message);assert.equal(validate?.(value!),undefined);if(secret)hidden.push(value!);return value!;},
      async choose(message,choices){const id=selections.shift();assert.ok(choices.some(c=>c.id===id),message);return id!;},
      async many(_message,choices){const ids=multi.shift()!;assert.ok(ids.every(id=>choices.some(c=>c.id===id)));return ids;},
      async yes(){return false;},note:m=>notes.push(m),async task(_message, action){return action();},
    };
    const connections:SetupConnections={
      async bot(token){assert.equal(token,'bot-secret');return 'demo_bot';},
      async telegram(){return {ownerId:42,chats:[{id:'-1001',label:'Личный чат'},{id:'-1002',label:'Учебный канал'}]};},
      async mail(){assert.equal(process.env.YANDEX_APP_PASSWORD,'mail-secret');return [{id:'INBOX',label:'Входящие'}];},
      async models(){return [{id:'actual-model',label:'Модель подписки'}];},
      async calendars(provider){called.push(provider);return provider==='google'?[{id:'schedule',label:'Чужое расписание',writable:false}]:[{id:'deadlines',label:'Дедлайны',writable:true}];},
    };
    const flow=new Onboarding(state,ui,connections);
    for(const section of ['profile','telegram','mail','model','calendars'] as const)await flow.run(section);
    const restored=new SetupState(dir,join(dir,'.env'),join(dir,'config.json'));await restored.load();
    assert.equal(restored.config.ownerId,42);assert.equal(restored.config.pollSeconds,90);
    assert.deepEqual(restored.config.chats,[{id:'-1002',title:'Учебный канал'}]);assert.deepEqual(restored.config.folders,['INBOX']);
    assert.equal(restored.config.model,'actual-model');assert.equal((restored.config.profile as any).name,'Анна');
    assert.deepEqual(calendarSettings(restored.config).calendars,{timetable:{provider:'google',id:'schedule',label:'Чужое расписание'},agent:{provider:'yandex',id:'deadlines',label:'Дедлайны'}});
    assert.deepEqual(called,['google','yandex']);
    const env=parse(await readFile(join(dir,'.env'),'utf8'));assert.equal(env.YANDEX_APP_PASSWORD,'mail-secret');assert.equal(env.YANDEX_CALENDAR_APP_PASSWORD,'calendar-secret');
    for(const secret of ['bot-secret','api-secret','mail-secret','google-secret','calendar-secret']){assert.ok(hidden.includes(secret));assert.ok(!notes.join('\n').includes(secret));}
    assert.equal((await stat(join(dir,'.env'))).mode&0o777,0o600);assert.equal((await stat(join(dir,'config.json'))).mode&0o777,0o600);
    assert.equal(inputs.length,0);assert.equal(selections.length,0);
  }finally{for(const [key,value]of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(dir,{recursive:true,force:true});}
});

test('CLI отмена выбора календаря не перезаписывает старые роли; завершённый профиль остаётся',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hse-onboarding-cancel-'));
  try{
    const state=new SetupState(dir,join(dir,'.env'),join(dir,'config.json'));await state.load();await state.profile(legacyProfile);
    await state.calendars({provider:'icloud',id:'old-schedule'},{provider:'icloud',id:'old-agent'});
    const disk=await readFile(state.configPath,'utf8');
    const ui={note(){},async choose(){throw new Error('Отменено');}} as unknown as SetupUI;
    await assert.rejects(()=>new Onboarding(state,ui,{} as SetupConnections).run('calendars'),/Отменено/);
    assert.equal(await readFile(state.configPath,'utf8'),disk);
    await assert.rejects(()=>state.calendars({provider:'yandex',id:'same'},{provider:'yandex',id:'same'}),/два разных/);
    assert.equal(await readFile(state.configPath,'utf8'),disk);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('env upsert сохраняет соседние секреты/комментарии, устраняет дубликаты и не интерпретирует значения',()=>{
  const value='abc # $TOKEN `code` \\ end';
  const text=upsertEnv('# настройки\nOTHER=keep\nTOKEN=old\nexport TOKEN=duplicate\n','TOKEN',value);
  assert.equal(parse(text).TOKEN,value);assert.equal(parse(text).OTHER,'keep');assert.equal(text.match(/^TOKEN=/gm)?.length,1);assert.ok(text.startsWith('# настройки'));
  assert.throws(()=>upsertEnv(text,'TOKEN','new\nINJECT=bad'),/одну строку/);
});

test('настроенный профиль заменяет сведения БПИ243 в системном промпте',()=>{
  const prompt=studyInstructions({...legacyProfile,name:'Анна',group:'БПМИ251',program:'ПМИ',subjects:'Алгебра',details:''});
  assert.match(prompt,/БПМИ251/);assert.match(prompt,/Алгебра/);assert.doesNotMatch(prompt,/БПИ243|Финансовые рынки|Нейроинформатика/);
  assert.match(prompt,/Сделал != сдал/);assert.match(prompt,/compaction/);
});

test('без профиля системный промпт не предполагает личные сведения прежнего владельца',()=>{
  const prompt=studyInstructions();
  assert.match(prompt,/Профиль владельца пока не заполнен/);
  assert.doesNotMatch(prompt,/Иван|БПИ243|Финансовые рынки|Нейроинформатика|C#/);
  assert.match(prompt,/Сделал != сдал/);assert.match(prompt,/compaction/);
});

test('Яндекс CalDAV проверяет feature flag и не отправляет авторизацию на чужой redirect',async()=>{
  assert.throws(()=>calendarSettings({calendars:{timetable:{provider:'yandex',id:'schedule'},agent:{provider:'yandex',id:'agent'}}}),/Яндекс.*отключен/);
  assert.equal(calendarSettings({features:{yandexCalendar:true},calendars:{timetable:{provider:'yandex',id:'schedule'},agent:{provider:'yandex',id:'agent'}}}).calendars.agent.provider,'yandex');
  for(const url of ['http://caldav.yandex.ru/','https://caldav.yandex.ru.evil.test/','https://user:password@caldav.yandex.ru/','https://caldav.yandex.ru:123/'])assert.throws(()=>yandexUrl(url));
  const previous=globalThis.fetch;const visited:string[]=[];
  globalThis.fetch=async(input)=>{visited.push(String(input));return new Response(null,{status:302,headers:{location:'https://evil.test/credentials'}});};
  try{await assert.rejects(()=>yandexFetch('https://caldav.yandex.ru/',{headers:{authorization:'Basic private'}}),/caldav.yandex.ru/);assert.deepEqual(visited,['https://caldav.yandex.ru/']);}finally{globalThis.fetch=previous;}
});
