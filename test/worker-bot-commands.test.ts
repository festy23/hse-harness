import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('calendar failure in /tasks does not mark Bot API offline or block later owner commands',{timeout:20000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hse-command-error-'));let child:ReturnType<typeof spawn>|undefined;
  try{
    await writeFile(join(dir,'.env'),'');
    await writeFile(join(dir,'config.json'),JSON.stringify({ownerId:1,chats:[],folders:[],model:'fixture',pollSeconds:15,features:{icloudCalendar:true,googleCalendar:false},calendars:{timetable:{provider:'icloud',id:'https://caldav.icloud.com/schedule/'},agent:{provider:'icloud',id:'https://caldav.icloud.com/agent/'}}}));
    const moduleURL=(name:string)=>new URL('../src/'+name,import.meta.url).href;
    const preload=`import {appendFile} from 'node:fs/promises';
import {TelegramSource} from ${JSON.stringify(moduleURL('telegram.ts'))};
import {MailSource} from ${JSON.stringify(moduleURL('mail.ts'))};
import {PiAssistant} from ${JSON.stringify(moduleURL('pi.ts'))};
import {ICloudAccount} from ${JSON.stringify(moduleURL('calendar/providers/icloud.ts'))};
TelegramSource.prototype.connect=async()=>{};TelegramSource.prototype.poll=async()=>{};TelegramSource.prototype.close=async()=>{};MailSource.prototype.poll=async()=>{};
PiAssistant.prototype.open=async()=>{};
ICloudAccount.prototype.collection=async function(id){return {identity:id,list:async()=>{throw new Error('Calendar read timeout')},changes:async()=>({events:[],full:true}),range:async()=>[]};};
let first=true;
globalThis.fetch=async(input,options)=>{
 const method=new URL(input).pathname.split('/').at(-1),args=JSON.parse(options.body);
 if(method==='getUpdates'){if(first){first=false;await new Promise(r=>setTimeout(r,300));}const result=['/tasks','/status','/start','/help'].map((text,i)=>({update_id:i+1,message:{message_id:i+1,chat:{id:1,type:'private'},from:{id:1},text}})).filter(x=>x.update_id>=args.offset);return Response.json({ok:true,result});}
 if(method==='sendMessage'){await appendFile(${JSON.stringify(join(dir,'sent.jsonl'))},JSON.stringify(args.text)+'\\n');return Response.json({ok:true,result:{message_id:1}});}
 throw new Error('Unexpected Bot API method');
};`;
    await writeFile(join(dir,'preload.mjs'),preload);
    child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),'--import',join(dir,'preload.mjs'),resolve('src/main.ts')],{cwd:dir,env:{...process.env,DOTENV_CONFIG_PATH:join(dir,'.env'),STUDY_CONFIG:join(dir,'config.json'),STUDY_DATA_DIR:join(dir,'data'),STUDY_SECRETS_DIR:join(dir,'secrets'),TELEGRAM_BOT_TOKEN:'1:fixture'},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout?.on('data',b=>output+=b);child.stderr?.on('data',b=>output+=b);
    let state:any;const until=Date.now()+12000;
    while(Date.now()<until){state=await readFile(join(dir,'data/operations.json'),'utf8').then(JSON.parse).catch(()=>undefined);if(state?.botOffset===5&&state.health['Бот']==='ok')break;await new Promise(r=>setTimeout(r,30));}
    assert.equal(state?.botOffset,5,'failed /tasks blocked later commands: '+output);
    assert.equal(state.health['Бот'],'ok');
    const sent=(await readFile(join(dir,'sent.jsonl'),'utf8')).trim().split('\n').map(x=>JSON.parse(x) as string);
    assert.ok(sent.some(x=>x.includes('список работ')&&x.includes('недоступен')));
    assert.ok(sent.some(x=>x.startsWith('{')&&x.includes('"health"')));
    assert.ok(sent.some(x=>x.includes('основной личный диалог')));
    const help=sent.find(x=>x.startsWith('Команды учебного помощника:'))!;
    for(const command of ['start','help','tasks','status','updates','ready'])assert.ok(help?.includes(`/${command} — `));
    assert.equal(state.queue.length,0,'/help must be handled without a model turn');
    assert.ok(!sent.some(x=>x.startsWith('Бот: сейчас недоступен')));
    const done=once(child,'exit');child.kill('SIGINT');assert.equal((await done)[0],0,output);
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}await rm(dir,{recursive:true,force:true});}
});
