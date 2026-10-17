import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('failure to deliver the startup notice leaves the opened Pi session usable for later owner messages',{timeout:12000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'startup-notice-review-'));let child:ReturnType<typeof spawn>|undefined;
  try{
    await writeFile(join(dir,'.env'),'');
    await writeFile(join(dir,'config.json'),JSON.stringify({ownerId:1,chats:[],folders:[],model:'fixture',pollSeconds:15,features:{icloudCalendar:true,googleCalendar:false},calendars:{timetable:{provider:'icloud',id:'https://caldav.icloud.com/schedule/'},agent:{provider:'icloud',id:'https://caldav.icloud.com/agent/'}}}));
    const moduleURL=(name:string)=>new URL('../src/'+name,import.meta.url).href;
    const preload=`import {appendFile} from 'node:fs/promises';
import {TelegramSource} from ${JSON.stringify(moduleURL('telegram.ts'))};
import {MailSource} from ${JSON.stringify(moduleURL('mail.ts'))};
import {PiAssistant} from ${JSON.stringify(moduleURL('pi.ts'))};
import {ICloudAccount} from ${JSON.stringify(moduleURL('calendar/providers/icloud.ts'))};
TelegramSource.prototype.poll=async()=>({complete:true,initialComplete:true});TelegramSource.prototype.close=async()=>{};MailSource.prototype.poll=async()=>({complete:true,initialComplete:true});
let alive=false,opened=0;
PiAssistant.prototype.open=async()=>{alive=true;opened++;};
PiAssistant.prototype.dispose=function(){alive=false;};
PiAssistant.prototype.prompt=async()=>{if(!alive)throw Error('Fixture session was disposed');return 'Fixture owner answer';};
ICloudAccount.prototype.collection=async function(id){return {identity:id,list:async()=>[],changes:async()=>({events:[],full:true}),range:async()=>[]};};
let first=true,startup=true;
globalThis.fetch=async(input,options)=>{
 const method=new URL(input).pathname.split('/').at(-1),args=JSON.parse(options.body);
 if(method==='getUpdates'){if(first){first=false;await new Promise(r=>setTimeout(r,250));}return Response.json({ok:true,result:args.offset<=1?[{update_id:1,message:{message_id:1,chat:{id:1,type:'private'},from:{id:1},text:'Fixture owner question'}}]:[]});}
 if(method==='sendMessage'){if(startup&&args.text.startsWith('Учебный помощник запущен.')){startup=false;return Response.json({ok:false,description:'Fixture startup delivery rejection'});}await appendFile(${JSON.stringify(join(dir,'sent.jsonl'))},JSON.stringify(args.text)+'\\n');return Response.json({ok:true,result:{message_id:1}});}
 throw Error('Unexpected fixture method');
};`;
    await writeFile(join(dir,'preload.mjs'),preload);
    child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),'--import',join(dir,'preload.mjs'),resolve('src/main.ts')],{cwd:dir,env:{...process.env,DOTENV_CONFIG_PATH:join(dir,'.env'),STUDY_CONFIG:join(dir,'config.json'),STUDY_DATA_DIR:join(dir,'data'),STUDY_SECRETS_DIR:join(dir,'secrets'),TELEGRAM_BOT_TOKEN:'1:fixture'},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout?.on('data',b=>{output+=b;});child.stderr?.on('data',b=>{output+=b;});
    let sent='';const until=Date.now()+5000;
    while(Date.now()<until){sent=await readFile(join(dir,'sent.jsonl'),'utf8').catch(()=>'');if(sent.includes('Fixture owner answer'))break;await new Promise(r=>setTimeout(r,25));}
    assert.ok(sent.includes('Fixture owner answer'),'startup notification failure disposed the usable session: '+output);
    const done=once(child,'exit');child.kill('SIGINT');assert.equal((await done)[0],0,output);
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}await rm(dir,{recursive:true,force:true});}
});
