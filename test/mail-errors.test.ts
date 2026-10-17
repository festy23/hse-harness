import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('failed IMAP connection and late socket error do not crash the bot process or advance mail cursors',()=>{
  const source=new URL('../src/mail.ts',import.meta.url).href;
  const script=`import {ImapFlow} from 'imapflow';
import {MailSource} from ${JSON.stringify(source)};
let closed=0;ImapFlow.prototype.close=function(){closed++;};
ImapFlow.prototype.connect=async function(){setTimeout(()=>this.emit('error',Object.assign(new Error('Socket timeout'),{code:'ETIMEOUT'})),20);throw Error('Connection failed');};
const store={state:{cursors:{}},enqueue:async()=>{throw Error('must not enqueue');}};
const mail=new MailSource({folders:['INBOX']},store);
let rejected=false;try{await mail.poll();}catch{rejected=true;}
if(!rejected||closed===0||Object.keys(store.state.cursors).length)process.exit(2);
await new Promise(r=>setTimeout(r,60));
console.log('socket-error-contained');`;
  const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,YANDEX_ADDRESS:'fixture@example.test',YANDEX_APP_PASSWORD:'fixture-only'},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/socket-error-contained/);
});

test('a socket error during a partial download preserves the cursor and a fresh connection retries the message',()=>{
  const script=`import {ImapFlow} from 'imapflow';import {Readable} from 'node:stream';
import {MailSource} from ${JSON.stringify(new URL('../src/mail.ts',import.meta.url).href)};
let failed=true,connections=0;ImapFlow.prototype.connect=async function(){connections++;};ImapFlow.prototype.close=function(){};
ImapFlow.prototype.getMailboxLock=async function(){this.mailbox={uidValidity:7n};return {release(){}};};
ImapFlow.prototype.search=async()=>[1];ImapFlow.prototype.fetchAll=async()=>[{uid:1,internalDate:new Date('2026-10-16T12:00:00Z'),bodyStructure:{type:'text/plain',part:'1'},envelope:{messageId:'fixture'}}];
ImapFlow.prototype.download=async function(){const client=this;return {content:Readable.from((async function*(){yield 'partial';if(failed){failed=false;client.emit('error',Error('Socket timeout'));}yield 'complete';})())};};
const store={state:{cursors:{},queue:[]},enqueue:async function(s){this.state.queue.push(s);},save:async()=>{}};
const source=new MailSource({folders:['INBOX']},store);let rejected=false;try{await source.poll();}catch{rejected=true;}
if(!rejected||store.state.queue.length||Object.keys(store.state.cursors).length)process.exit(2);
await source.poll();if(connections!==2||store.state.queue.length!==1||store.state.cursors['mail:INBOX']!=='7:1')process.exit(3);
console.log('mail-recovered-without-loss');`;
  const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e',script],{env:{...process.env,YANDEX_ADDRESS:'fixture@example.test',YANDEX_APP_PASSWORD:'fixture-only'},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/mail-recovered-without-loss/);
});

test('CLI mail discovery contains late IMAP errors after a rejected connection',()=>{
  const script=`import {ImapFlow} from 'imapflow';
import {connectMail} from ${JSON.stringify(new URL('../src/cli/connections/mail.ts',import.meta.url).href)};
let closed=0;ImapFlow.prototype.close=function(){closed++;};
ImapFlow.prototype.connect=async function(){setTimeout(()=>this.emit('error',Error('Socket timeout')),20);throw Error('Connection failed');};
let rejected=false;try{await connectMail({task:async(_label,run)=>run()});}catch{rejected=true;}
if(!rejected||closed===0)process.exit(2);
await new Promise(r=>setTimeout(r,60));console.log('discovery-error-contained');`;
  const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e',script],{env:{...process.env,YANDEX_ADDRESS:'fixture@example.test',YANDEX_APP_PASSWORD:'fixture-only'},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/discovery-error-contained/);
});
