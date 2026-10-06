// Loaded only by test/e2e/run.mjs. Substitute external transports; application code is unchanged.
import timers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { TelegramClient, Api } from 'teleproto';
import bigInt from 'big-integer';
import { ImapFlow } from 'imapflow';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

const endpoint=process.env.STUDY_E2E_ENDPOINT;
if(!endpoint || new URL(endpoint).hostname!=='127.0.0.1')throw new Error('E2E requires a loopback endpoint');
const realFetch=globalThis.fetch;
let now=Date.parse('2026-10-04T09:00:00Z');
Date.now=()=>now;
const pause=timers.setTimeout;
timers.setTimeout=(ms,value,options)=>pause(Math.max(10,Math.min(300,ms/100)),value,options);
syncBuiltinESMExports();
globalThis.fetch=async(input,options)=>{
  let url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  const original=url.href;
  if(url.hostname==='api.telegram.org')url=new URL('/bot/'+url.pathname.split('/').at(-1),endpoint);
  else if(url.hostname==='www.googleapis.com')url=new URL('/google/'+url.pathname.split('/calendar/v3/')[1]+url.search,endpoint);
  else if(url.hostname==='caldav.icloud.com'||url.hostname==='caldav.yandex.ru')url=new URL('/icloud'+url.pathname+url.search,endpoint);
  if(url.origin!==new URL(endpoint).origin)throw new Error(`E2E blocks external network: ${url.hostname}`);
  const response=await realFetch(url,options);
  Object.defineProperty(response,'url',{value:original});
  const clock=response.headers.get('x-test-now');if(clock)now=Number(clock);
  return response;
};
async function wire(path,body={}){
  const r=await fetch(endpoint+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok)throw new Error(`Fixture ${path}: ${r.status}`);
  return r.json();
}

const channel=new Api.InputPeerChannel({channelId:bigInt(123),accessHash:bigInt(1)});
function message(m){return new Api.Message({id:m.id,peerId:new Api.PeerChannel({channelId:bigInt(123)}),date:Math.floor(Date.parse(m.date)/1000),message:m.text,...(m.replyTo?{replyTo:new Api.MessageReplyHeader({replyToMsgId:m.replyTo})}:{})});}
TelegramClient.prototype.connect=async()=>{};
TelegramClient.prototype.disconnect=async()=>{};
TelegramClient.prototype.checkAuthorization=async()=>true;
TelegramClient.prototype.getDialogs=async()=>[{id:bigInt('-100123'),entity:channel}];
TelegramClient.prototype.getInputEntity=async()=>channel;
TelegramClient.prototype.iterMessages=async function*(){for(const m of await wire('/tg/history'))yield message(m);};
TelegramClient.prototype.invoke=async function(request){
  if(request instanceof Api.updates.GetState)return new Api.updates.State({pts:1,qts:0,date:1791104400,seq:1,unreadCount:0});
  if(request instanceof Api.channels.GetFullChannel)return {fullChat:new Api.ChannelFull({id:bigInt(123),pts:1,about:'Fixture'})};
  if(request instanceof Api.updates.GetDifference)return new Api.updates.DifferenceEmpty({date:1791104400,seq:1});
  if(request instanceof Api.updates.GetChannelDifference){
    const d=await wire('/tg/difference',{pts:request.pts});
    return new Api.updates.ChannelDifference({final:true,pts:d.pts,newMessages:d.messages.map(message),otherUpdates:[],users:[],chats:[]});
  }
  if(request instanceof Api.messages.SendMessage){
    const sent=await wire('/tg/send',{text:request.message,randomId:request.randomId.toString()});
    return new Api.UpdateShortSentMessage({id:sent.id,pts:1,ptsCount:1,date:1791104400});
  }
  throw new Error(`Unexpected MTProto method ${request.className}`);
};

ImapFlow.prototype.connect=async function(){};
ImapFlow.prototype.logout=async function(){};
ImapFlow.prototype.list=async()=>[{path:'INBOX',flags:new Set()}];
ImapFlow.prototype.getMailboxLock=async function(){this.mailbox={uidValidity:1n};return {release(){}};};
ImapFlow.prototype.search=async()=> (await wire('/mail/list')).map(m=>m.uid);
ImapFlow.prototype.fetchAll=async(ids)=> (await wire('/mail/list')).filter(m=>ids.includes(m.uid)).map(m=>({uid:m.uid,internalDate:new Date(m.date),envelope:{messageId:`<fixture-${m.uid}>`,subject:m.subject,from:[{address:'teacher@example.test'}]},bodyStructure:{type:'text/plain',part:'1'}}));
ImapFlow.prototype.download=async(uid)=>({content:Readable.from([(await wire('/mail/list')).find(m=>m.uid===Number(uid)).text])});

const createRuntime=ModelRuntime.create.bind(ModelRuntime);
ModelRuntime.create=async options=>{
  const runtime=await createRuntime({...options,allowModelNetwork:false,refreshOnCreate:false});
  const auth=await wire('/runtime/auth');
  const model={...runtime.getModels('openai')[0],id:'e2e-scripted',name:'E2E scripted model'};
  runtime.getModel=()=>model;
  runtime.getPhysicalModel=()=>model;
  runtime.isUsingSubscription=()=>auth.ready; // Fixture auth only; never a production login/fallback.
  runtime.hasConfiguredAuth=()=>true;
  runtime.checkAuth=async()=>({apiKey:'fixture'});
  runtime.getAuth=async()=>({auth:{apiKey:'fixture'}});
  runtime.streamSimple=(_model,context)=>{
    const stream=new AssistantMessageEventStream();
    void wire('/model',{messages:context.messages}).then(answer=>{
      const response={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:answer.content,stopReason:answer.error?'error':answer.content.some(x=>x.type==='toolCall')?'toolUse':'stop',timestamp:Date.now(),usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},...(answer.error?{errorMessage:answer.error}:{})};
      stream.push({type:'start',partial:response});
      stream.push(response.stopReason==='error'?{type:'error',reason:'error',error:response}:{type:'done',reason:response.stopReason,message:response});
    }).catch(error=>stream.end({role:'assistant',content:[],stopReason:'error',errorMessage:String(error),timestamp:Date.now(),api:model.api,provider:model.provider,model:model.id}));
    return stream;
  };
  return runtime;
};
