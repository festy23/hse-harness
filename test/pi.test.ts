import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Type } from 'typebox';
import { ModelRuntime,SessionManager,createAgentSession,SettingsManager } from '@earendil-works/pi-coding-agent';
import { resourceLoader,loginSubscription,subscriptionModels } from '../src/pi.js';

test('setup models показывает только каталог подписки, поддержанный Pi, без платного fallback и HTML в ошибках',async()=>{
  let signedIn=true,requests=0;
  const runtime={isUsingSubscription:()=>signedIn,getAuth:async()=>({auth:{apiKey:'fixture-token'}}),getModel:(_provider:string,id:string)=>['account-only','sdk-only'].includes(id)?{id}:undefined} as unknown as ModelRuntime;
  const request:typeof fetch=async(input,init)=>{
    requests++;assert.equal(input,'https://api.openai.com/v1/models');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-token');
    return Response.json({models:[{slug:'unknown-to-sdk'},{slug:'account-only',display_name:'Account model'}]});
  };
  assert.deepEqual(await subscriptionModels(runtime,request),[{id:'account-only',name:'Account model'}]);
  signedIn=false;await assert.rejects(()=>subscriptionModels(runtime,request),/Требуется подписочный вход/);assert.equal(requests,1);
  signedIn=true;await assert.rejects(()=>subscriptionModels(runtime,async()=>new Response('<!DOCTYPE html>private response',{headers:{'content-type':'text/html'}})),/^Error: Каталог подписки вернул не JSON/);
  await assert.rejects(()=>subscriptionModels(runtime,async()=>new Response('private response',{status:403})),/^Error: Каталог подписки: HTTP 403$/);
});

test('подписочный OAuth получает постоянный UUID установки через штатные настройки Pi',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pi-login-test-')),agentDir=join(dir,'pi');
  try{
    const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
    const controller=new AbortController();let url:URL|undefined;
    await assert.rejects(()=>loginSubscription(runtime,{
      signal:controller.signal,
      notify(event){if(event.type==='auth_url')url=new URL(event.url);},
      async prompt(){controller.abort();throw new Error('Cancelled by test');},
    },dir,agentDir),/Login cancelled|This operation was aborted/);
    assert.ok(url,'OAuth дошел до браузерного входа без обращения к token endpoint');
    const host=url.searchParams.get('ext_agent_host_id');
    assert.match(host??'',/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const reopened=SettingsManager.create(dir,agentDir);
    assert.equal(`urn:uuid:${reopened.getOrCreateDeviceId()}`,host,'повторный запуск использует тот же UUID');
    await reopened.flush();
    assert.equal(runtime.isUsingSubscription('openai'),false,'отмененный вход не считается успешным');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('настоящий Pi SDK восстанавливает JSONL и оставляет только разрешенные инструменты без shell/extensions',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pi-test-'));
  try{
    const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
    const model=runtime.getModels('openai')[0];assert.ok(model,'В SDK есть статический каталог OpenAI');
    const manager=SessionManager.create(dir);manager.appendCustomMessageEntry('study-test','Срок ДЗ A перенесен на 2026-10-23. Работа сделана, не сдана.',false);
    manager.appendMessage({role:'user',content:'Продолжим отслеживание заданий.',timestamp:Date.now()});
    const tools=[{name:'study_only',label:'study_only',description:'test',parameters:Type.Object({}),execute:async()=>({content:[{type:'text' as const,text:'ok'}],details:{}})}];
    const create=(sm:SessionManager)=>createAgentSession({cwd:dir,sessionManager:sm,modelRuntime:runtime,model,resourceLoader:resourceLoader('test'),customTools:tools,tools:['study_only'],noTools:'builtin',settingsManager:SettingsManager.inMemory({compaction:{enabled:true}})});
    const first=await create(manager);assert.deepEqual(first.session.getActiveToolNames(),['study_only']);first.session.dispose();
    const resumed=await create(SessionManager.open(manager.getSessionFile()!));
    try{assert.deepEqual(resumed.session.getActiveToolNames(),['study_only']);assert.match(JSON.stringify(resumed.session.messages),/2026-10-23/);assert.match(JSON.stringify(resumed.session.messages),/не сдана/);}finally{resumed.session.dispose();}
  }finally{await rm(dir,{recursive:true,force:true});}
});
