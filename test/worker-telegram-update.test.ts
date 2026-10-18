import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

for(const mode of ['manual','automatic'] as const)test(`managed worker ${mode} updates work through Bot API while calendar/model startup is unavailable`,{timeout:35000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hse-worker-update-'));let child:ReturnType<typeof spawn>|undefined,output='',complete=false;
 const compiled=process.env.HSE_UPDATES_E2E_COMPILED==='1',app=compiled?'dist':'src',extension=compiled?'js':'ts';
 const artifacts=process.env.HSE_UPDATES_E2E_ARTIFACTS?join(resolve(process.env.HSE_UPDATES_E2E_ARTIFACTS),mode):undefined;
 try{
  const home=join(dir,'home'),manifestPath=join(dir,'prefix/lib/node_modules/@ivan-boss/hse-harness/package.json');await mkdir(join(home,'runtime'),{recursive:true});await mkdir(join(dir,'prefix/lib/node_modules/@ivan-boss/hse-harness'),{recursive:true});
  const manifest={protocolVersion:1,stateSchemaVersion:2,piVersion:'1.0.2',minSupervisorVersion:'1.0.0',formats:{operations:2,auth:1},writableStateVersion:2};
  const integrity='sha512-'+Buffer.alloc(64,1).toString('base64');
  await writeFile(manifestPath,JSON.stringify({version:'0.2.2'}));
  await writeFile(join(home,'runtime/state.json'),JSON.stringify({installation:{manifestPath},active:{version:'0.2.2',manifest},runningVersion:'0.2.2',supervisorVersion:'1.0.0',quarantine:[]}));await writeFile(join(home,'runtime/settings.json'),JSON.stringify({enabled:true}));
  await mkdir(join(dir,'user'));await writeFile(join(dir,'.env'),'');await writeFile(join(dir,'config.json'),JSON.stringify({ownerId:1,chats:[],folders:[],model:'fixture',pollSeconds:15,features:{icloudCalendar:true,googleCalendar:false},calendars:{timetable:{provider:'icloud',id:'https://caldav.icloud.com/schedule/'},agent:{provider:'icloud',id:'https://caldav.icloud.com/agent/'}}}));
  const npm=join(dir,'npm');await writeFile(npm,`#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(manifestPath)},JSON.stringify({version:'0.2.3'}));fs.appendFileSync(${JSON.stringify(join(dir,'install-count'))},'installed\\n');`,{mode:0o700});
  const url=(path:string)=>new URL('../'+path,import.meta.url).href;
  const preload=`import {appendFile,readFile} from 'node:fs/promises';
import {ICloudAccount} from ${JSON.stringify(url(`${app}/calendar/providers/icloud.${extension}`))};
import {TelegramSource} from ${JSON.stringify(url(`${app}/telegram.${extension}`))};
import {ReleaseStore} from ${JSON.stringify(url('runtime/releases.mjs'))};
TelegramSource.prototype.close=async()=>{};
ICloudAccount.prototype.collection=async()=>{throw Error('Calendar unavailable');};
ReleaseStore.prototype.prepare=async()=>({version:'0.2.3',integrity:${JSON.stringify(integrity)},manifest:${JSON.stringify(manifest)}});
const automatic=${JSON.stringify(mode==='automatic')};
let button,sent=false,step=0,enable,disable,enableAgain,disabled=false,panelAfterDisable=false,enabledFinal=false;
const buttonLabels=new Map();
const callback=(id,data)=>({update_id:id,callback_query:{id:String(id),from:{id:1},message:{chat:{id:1,type:'private'}},data}});
const command=id=>({update_id:id,message:{message_id:id,from:{id:1},chat:{id:1,type:'private'},text:'/updates'}});
globalThis.fetch=async(input,options)=>{
 const u=new URL(input);if(u.hostname==='registry.npmjs.org'){const version=automatic&&step<5?'0.2.2':'0.2.3';return Response.json({'dist-tags':{latest:version},versions:{[version]:{name:'@ivan-boss/hse-harness',version,dist:{integrity:${JSON.stringify(integrity)},tarball:'https://registry.npmjs.org/pkg.tgz'}}}});}
 const method=u.pathname.split('/').at(-1),args=JSON.parse(options.body);
 if(method==='getUpdates'){
  await new Promise(r=>setTimeout(r,50));let result=[];
  if(!automatic&&button&&!sent){sent=true;result=[callback(1,button),callback(2,button)];}
  if(automatic){
   if(step===0){step=1;result=[command(1)];}
   else if(step===1&&enable){step=2;result=[callback(2,enable)];}
   else if(step===2&&disable){step=3;result=[callback(3,disable)];}
   else if(step===3&&disabled){step=4;result=[command(4)];}
   else if(step===4&&panelAfterDisable){step=5;result=[callback(5,enableAgain),callback(6,enableAgain)];}
   else if(step===5&&enabledFinal){step=6;result=[command(7)];}
  }
  for(const update of result)await appendFile(${JSON.stringify(join(dir,'dialogue.jsonl'))},JSON.stringify({actor:'owner',text:update.message?.text??'Нажата кнопка «'+buttonLabels.get(update.callback_query.data)+'»'})+'\\n');
  return Response.json({ok:true,result});
 }
 if(method==='sendMessage'){
  await appendFile(${JSON.stringify(join(dir,'sent.jsonl'))},JSON.stringify(args)+'\\n');
  const buttons=args.reply_markup?.inline_keyboard.flat()??[];
  for(const b of buttons)buttonLabels.set(b.callback_data,b.text);
  await appendFile(${JSON.stringify(join(dir,'dialogue.jsonl'))},JSON.stringify({actor:'bot',text:args.text,buttons:buttons.map(b=>b.text)})+'\\n');
  button??=buttons.find(x=>x.callback_data.startsWith('hse_update:'))?.callback_data;
  if(automatic){
   if(step===1&&args.text.startsWith('Обновления HSE HARNESS'))enable=buttons.find(x=>x.callback_data.startsWith('hse_auto:on:'))?.callback_data;
   if(step===2&&args.text.startsWith('Автообновление включено.'))disable=buttons.find(x=>x.callback_data.startsWith('hse_auto:off:'))?.callback_data;
   if(step===3&&args.text.startsWith('Автообновление выключено.'))disabled=true;
   if(step===4&&args.text.startsWith('Обновления HSE HARNESS')){
    const installed=await readFile(${JSON.stringify(join(dir,'install-count'))},'utf8').then(()=>true,e=>{if(e.code!=='ENOENT')throw e;return false;});
    if(installed)throw Error('Unexpected installation with policy disabled');
    enableAgain=buttons.find(x=>x.callback_data.startsWith('hse_auto:on:'))?.callback_data;panelAfterDisable=true;
   }
   if(step===5&&args.text.startsWith('Автообновление включено.'))enabledFinal=true;
  }
  return Response.json({ok:true,result:{message_id:1}});
 }
 if(method==='answerCallbackQuery')return Response.json({ok:true,result:true});
 throw Error('Unexpected network request');
};`;
  await writeFile(join(dir,'preload.mjs'),preload);
  // Do not inherit real Telegram/mail/model credentials or the user's auth home.
  child=spawn(process.execPath,[...(!compiled?['--import',import.meta.resolve('tsx')]:[]),'--import',join(dir,'preload.mjs'),resolve(app,`main.${extension}`)],{cwd:dir,env:{PATH:process.env.PATH,HOME:join(dir,'user'),TMPDIR:process.env.TMPDIR,npm_execpath:npm,HSE_HARNESS_HOME:home,HSE_RELEASE_VERSION:'0.2.2',HSE_WORKER_ID:'test-worker',DOTENV_CONFIG_PATH:join(dir,'.env'),STUDY_CONFIG:join(dir,'config.json'),STUDY_DATA_DIR:join(dir,'data'),STUDY_SECRETS_DIR:join(dir,'secrets'),TELEGRAM_BOT_TOKEN:'1:fixture'},stdio:['ignore','pipe','pipe','ipc']});
  child.stdout?.on('data',b=>output+=b);child.stderr?.on('data',b=>output+=b);
  child.on('message',(message:any)=>{if(message.type==='boot-ready')child!.send({protocolVersion:1,attemptId:'boot',workerId:'test-worker',sequence:2,type:'activate'});});
  child.send({protocolVersion:1,attemptId:'boot',workerId:'test-worker',sequence:1,type:'prepare'});
  const expectedOffset=mode==='automatic'?8:3;
  let state:any;const until=Date.now()+28000;
  while(Date.now()<until){state=await readFile(join(dir,'data/operations.json'),'utf8').then(JSON.parse).catch(()=>undefined);if(state?.npmUpdates?.request?.phase==='awaiting-apply'&&state.botOffset===expectedOffset)break;await new Promise(r=>setTimeout(r,40));}
  assert.equal(state?.npmUpdates?.request?.phase,'awaiting-apply',output);assert.equal(state.botOffset,expectedOffset);assert.equal(state.health['Календарь'],'unavailable');assert.equal(state.health['Бот'],'ok');assert.equal(await readFile(join(dir,'install-count'),'utf8'),'installed\n');
  const sent=(await readFile(join(dir,'sent.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(sent.some(x=>x.reply_markup?.inline_keyboard[0][0].text==='Обновить'));assert.ok(sent.some(x=>/запускаю обновление/i.test(x.text)));
  assert.equal(state.npmUpdates.request.automatic,mode==='automatic');
  if(mode==='automatic'){
   assert.equal(JSON.parse(await readFile(join(home,'runtime/settings.json'),'utf8')).automaticUpdates,true);
   assert.ok(sent.some(x=>x.text.includes('Текущая версия бота: 0.2.2')&&x.text.includes('Последняя версия в npm: 0.2.3')));
   assert.ok(sent.some(x=>x.text.includes('Автообновление: 🔴 выключено')));
   assert.ok(sent.some(x=>x.text.includes('Автообновление: 🟢 включено')));
  }
  const done=once(child,'exit');child.kill('SIGINT');assert.equal((await done)[0],0,output);
  complete=true;
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}
  try{if(artifacts){
   await mkdir(artifacts,{recursive:true});await writeFile(join(artifacts,'bot.log'),output);
   const dialogue=await readFile(join(dir,'dialogue.jsonl'),'utf8').then(text=>text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))).catch(()=>[]);
   await writeFile(join(artifacts,'dialogue.json'),JSON.stringify(dialogue,null,2)+'\n');
   const settings=await readFile(join(dir,'home/runtime/settings.json'),'utf8').then(JSON.parse).catch(()=>undefined);
   const operations=await readFile(join(dir,'data/operations.json'),'utf8').then(JSON.parse).catch(()=>undefined);
   await writeFile(join(artifacts,'result.json'),JSON.stringify({success:complete,mode,compiled,automaticUpdates:settings?.automaticUpdates??false,requestPhase:operations?.npmUpdates?.request?.phase,scope:'Real daemon and Bot API command handling; Telegram, registry, package preparation, installer and supervisor driver are fixtures. Actual version switching is checked separately.'},null,2)+'\n');
  }}finally{await rm(dir,{recursive:true,force:true});}
 }
});
