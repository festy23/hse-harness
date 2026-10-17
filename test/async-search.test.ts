import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {PiAssistant} from '../src/pi.js';
import {createOperation} from '../src/operations.js';
import {prettyTime} from '../src/domain.js';

test('cooperative original-entry search preserves newest eight matches in chronological order and truncation',async()=>{
  const pi=new PiAssistant();pi.manager=SessionManager.inMemory();
  for(let i=0;i<12;i++)pi.manager.appendCustomEntry('fixture',{i,text:'ДЕДЛАЙН '+(i===11?'я'.repeat(13000):'исходная запись')});
  const entries=pi.manager.getEntries();const expected=entries.filter(e=>JSON.stringify(e).toLowerCase().includes('дедлайн')).slice(-8).map(e=>JSON.stringify(e).slice(0,12000));
  assert.deepEqual(await pi.search('ДедЛаЙн'),expected);assert.equal((await pi.search('ДедЛаЙн')).at(-1)?.length,12000);
});

test('absent-query full-history scan yields to timers and observes cancellation',async()=>{
  const pi=new PiAssistant();pi.manager=SessionManager.inMemory();
  for(let i=0;i<10000;i++)pi.manager.appendCustomEntry('fixture',{i,text:'учебные сведения '.repeat(128)});
  let timerRan=false;setImmediate(()=>{timerRan=true;});assert.deepEqual(await pi.search('нет совпадения'),[]);assert.equal(timerRan,true);
  const ctx=createOperation('tool',1000);ctx.abort();try{await assert.rejects(pi.search('учебные',ctx));}finally{ctx.dispose();}
});

test('cached Moscow formatter preserves the existing Russian output',()=>{
  for(const date of ['2026-01-01T00:00:00Z','2026-07-01T20:59:00Z','2026-10-20T09:00:00Z'])assert.equal(prettyTime(date),new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'medium',timeStyle:'short'}).format(new Date(date)));
});
