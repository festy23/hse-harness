import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

function scenario(body:string):void {
  const script=`import assert from 'node:assert/strict';
import {ImapFlow} from 'imapflow';
import {MailSource} from ${JSON.stringify(new URL('../src/mail.ts',import.meta.url).href)};
import {createOperation,OperationError} from ${JSON.stringify(new URL('../src/operations.ts',import.meta.url).href)};
const connections=[],closed=new Set();let saves=0;
ImapFlow.prototype.close=function(){closed.add(this);};
const store={state:{cursors:{},queue:[]},save:async()=>{saves++;},enqueue:async sources=>{store.state.queue.push(...sources);}};
const source=new MailSource({folders:['INBOX']},store);
${body}`;
  const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e',script],{
    cwd:process.cwd(),env:{...process.env,YANDEX_ADDRESS:'fixture@example.test',YANDEX_APP_PASSWORD:'fixture-only'},encoding:'utf8',timeout:10_000,
  });
  assert.equal(result.status,0,result.stderr);
}

test('mail reconnects after recorded TCP/TLS failures before reading and enqueues each message once',()=>{
  scenario(`ImapFlow.prototype.connect=async function(){
  connections.push(this);
  assert.equal(saves,0);assert.equal(store.state.queue.length,0);
  if(connections.length<3){
    const error=Object.assign(new Error('recorded connection failure'),{code:connections.length===1?'ECONNRESET':'ClosedAfterConnectTLS'});
    setTimeout(()=>this.emit('error',error),20);throw error;
  }
};
ImapFlow.prototype.getMailboxLock=async function(_folder,options){assert.equal(options.readOnly,true);assert.equal(connections.length,3);this.mailbox={uidValidity:7n};return {release(){}};};
ImapFlow.prototype.search=async()=>[1];
ImapFlow.prototype.fetchAll=async()=>[{uid:1,internalDate:new Date('2026-11-14T12:00:00Z'),envelope:{messageId:'retry-fixture'}}];
const result=await source.poll();
assert.equal(result.complete,true);assert.equal(new Set(connections).size,3);
assert.ok(connections.every(client=>closed.has(client)));
assert.equal(store.state.queue.length,1);assert.equal(store.state.cursors['mail:INBOX'],'7:1');`);
});

test('persistent connection failures stop after three attempts without advancing mail state',()=>{
  scenario(`ImapFlow.prototype.connect=async function(){connections.push(this);throw Object.assign(new Error('reset'),{code:'ECONNRESET'});};
await assert.rejects(source.poll(),{code:'ECONNRESET'});
assert.equal(connections.length,3);assert.ok(connections.every(client=>closed.has(client)));
assert.equal(saves,0);assert.deepEqual(store.state.cursors,{});assert.equal(store.state.queue.length,0);`);
});

test('authentication failures are reported immediately even when a network code is attached',()=>{
  scenario(`ImapFlow.prototype.connect=async function(){connections.push(this);throw Object.assign(new Error('authentication rejected'),{code:'ECONNRESET',authenticationFailed:true});};
await assert.rejects(source.poll(),{authenticationFailed:true});
assert.equal(connections.length,1);assert.equal(saves,0);assert.ok(closed.has(connections[0]));`);
});

test('stopping during reconnect backoff cancels the poll without another connection',()=>{
  scenario(`const parent=createOperation('source',5000);const reason=new OperationError('cancelled','test stop','stop');
ImapFlow.prototype.connect=async function(){connections.push(this);setTimeout(()=>parent.abort(reason),10);throw Object.assign(new Error('reset'),{code:'ECONNRESET'});};
try{await assert.rejects(source.poll(parent),error=>error===reason);}finally{parent.dispose();}
assert.equal(connections.length,1);assert.equal(saves,0);assert.ok(closed.has(connections[0]));`);
});

test('a reset after connecting leaves the mail cursor unchanged for the next poll',()=>{
  scenario(`ImapFlow.prototype.connect=async function(){connections.push(this);};
ImapFlow.prototype.getMailboxLock=async function(){throw Object.assign(new Error('read reset'),{code:'ECONNRESET'});};
await assert.rejects(source.poll(),{code:'ECONNRESET'});
assert.equal(connections.length,1);assert.equal(saves,0);assert.deepEqual(store.state.cursors,{});`);
});
