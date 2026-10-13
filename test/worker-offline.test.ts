import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

// Compile into an isolated fixture instead of trusting stale project dist/.
// Dependencies resolve from the repository ancestor; no live accounts are used.
test('actual compiled offline worker yields to lazy imports and SIGINT instead of spinning sibling retries',{timeout:20000},async()=>{
  const project=resolve('.');await mkdir(join(project,'data/e2e'),{recursive:true});const folder=await mkdtemp(join(project,'data/e2e/offline-regression-'));
  let child:ReturnType<typeof spawn>|undefined;
  try{
    const compiler=spawn(process.execPath,[join(project,'node_modules/typescript/bin/tsc'),'-p',join(project,'tsconfig.json'),'--outDir',join(folder,'dist')],{stdio:['ignore','pipe','pipe']});let compileOutput='';compiler.stderr.on('data',b=>{compileOutput+=b;});compiler.stdout.on('data',b=>{compileOutput+=b;});assert.equal((await once(compiler,'exit'))[0],0,compileOutput);
    await mkdir(join(folder,'bin'));await copyFile(join(project,'bin/hse-harness.mjs'),join(folder,'bin/hse-harness.mjs'));await writeFile(join(folder,'package.json'),JSON.stringify({name:'@ivan-boss/hse-harness',version:'0.2.0',type:'module'}));
    const config=JSON.parse(await readFile(join(project,'config.example.json'),'utf8'));await writeFile(join(folder,'config.local.json'),JSON.stringify({...config,ownerId:1,chats:[]}));await writeFile(join(folder,'.env'),"TELEGRAM_BOT_TOKEN='fixture-only'\n");
    const preload=join(folder,'offline.mjs');await writeFile(preload,"import timers from 'node:timers/promises';import {syncBuiltinESMExports} from 'node:module';const pause=timers.setTimeout;timers.setTimeout=(ms,v,o)=>pause(Math.min(ms,30),v,o);syncBuiltinESMExports();globalThis.fetch=async()=>{throw new Error('Offline fixture')};");
    child=spawn(process.execPath,['--import',preload,join(folder,'bin/hse-harness.mjs'),'run'],{cwd:folder,env:{PATH:process.env.PATH,HOME:folder,HSE_HARNESS_HOME:folder,DOTENV_CONFIG_PATH:join(folder,'.env'),STUDY_CONFIG:join(folder,'config.local.json'),STUDY_DATA_DIR:join(folder,'data'),STUDY_SECRETS_DIR:join(folder,'secrets')},stdio:['ignore','pipe','pipe']});
    let output='',interrupted=false;const ended=once(child,'exit');const append=(b:Buffer)=>{output+=b;if(!interrupted&&/Бот unavailable/.test(output)){interrupted=true;child!.kill('SIGINT');}};child.stdout?.on('data',append);child.stderr?.on('data',append);
    let watchdog:NodeJS.Timeout|undefined;const [code]=await Promise.race([ended,new Promise<never>((_,reject)=>{watchdog=setTimeout(()=>reject(Error('Offline worker starved graceful shutdown: '+output)),7000);})]).finally(()=>{if(watchdog)clearTimeout(watchdog);});
    assert.ok(interrupted,output);assert.equal(code,0,output);await assert.rejects(readFile(join(folder,'data/service.lock')),{code:'ENOENT'});
  }finally{if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}await rm(folder,{recursive:true,force:true});}
});
