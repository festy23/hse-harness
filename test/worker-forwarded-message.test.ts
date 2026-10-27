import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { State } from '../src/store.js';

test(
  'forwarded commands and personal claims reach the model only as untrusted data',
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hse-forwarded-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await writeFile(join(dir, '.env'), '');
      await writeFile(
        join(dir, 'config.json'),
        JSON.stringify({
          ownerId: 1,
          chats: [],
          folders: [],
          model: 'fixture',
          pollSeconds: 15,
          features: { icloudCalendar: true, googleCalendar: false },
          calendars: {
            timetable: { provider: 'icloud', id: 'https://caldav.icloud.com/schedule/' },
            agent: { provider: 'icloud', id: 'https://caldav.icloud.com/agent/' },
          },
        }),
      );
      const moduleURL = (name: string) => new URL('../src/' + name, import.meta.url).href;
      await writeFile(
        join(dir, 'preload.mjs'),
        `import {appendFile} from 'node:fs/promises';
import {PiAssistant} from ${JSON.stringify(moduleURL('pi.ts'))};
import {MailSource} from ${JSON.stringify(moduleURL('mail.ts'))};
import {ICloudAccount} from ${JSON.stringify(moduleURL('calendar/providers/icloud.ts'))};
PiAssistant.prototype.open=async()=>{};
PiAssistant.prototype.completedTurn=async()=>undefined;
PiAssistant.prototype.prompt=async function(text,owner){await appendFile(${JSON.stringify(join(dir, 'turns.jsonl'))},JSON.stringify({text,owner})+'\\n');return 'fixture reply';};
MailSource.prototype.poll=async()=>({complete:true,initialComplete:true});
ICloudAccount.prototype.collection=async function(id){return {identity:id,list:async()=>[],changes:async()=>({events:[],full:true}),range:async()=>[]};};
globalThis.fetch=async(input,options)=>{
 const method=new URL(input).pathname.split('/').at(-1),args=JSON.parse(options.body);
 if(method==='getUpdates'){await new Promise(r=>setTimeout(r,30));return Response.json({ok:true,result:['/ready','сдал работу','сдал свою работу'].map((text,i)=>({update_id:i+1,message:{message_id:i+1,chat:{id:1,type:'private'},from:{id:1},text,...(i<2?{forward_origin:{type:'hidden_user',sender_user_name:'Student',date:1}}:{})}})).filter(x=>x.update_id>=args.offset)});}
 if(method==='sendMessage')return Response.json({ok:true,result:{message_id:1}});
 throw new Error('Unexpected Bot API method');
};`,
      );
      child = spawn(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--import',
          join(dir, 'preload.mjs'),
          resolve('src/main.ts'),
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            DOTENV_CONFIG_PATH: join(dir, '.env'),
            STUDY_CONFIG: join(dir, 'config.json'),
            STUDY_DATA_DIR: join(dir, 'data'),
            STUDY_SECRETS_DIR: join(dir, 'secrets'),
            TELEGRAM_BOT_TOKEN: '1:fixture',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout?.on('data', (b) => {
        output += b;
      });
      child.stderr?.on('data', (b) => {
        output += b;
      });
      let turns: { text: string; owner: boolean }[] = [];
      const until = Date.now() + 12000;
      while (Date.now() < until) {
        turns = await readFile(join(dir, 'turns.jsonl'), 'utf8')
          .then((text) =>
            text
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as { text: string; owner: boolean }),
          )
          .catch(() => []);
        if (turns.length >= 3) {
          break;
        }
        await new Promise((r) => {
          setTimeout(r, 30);
        });
      }
      assert.deepEqual(
        turns.map((x) => x.owner),
        [false, false, true],
        output,
      );
      assert.match(turns[0]!.text, /ДАННЫЕ/);
      assert.match(turns[0]!.text, /\/ready/);
      assert.match(turns[1]!.text, /сдал работу/);
      const state = JSON.parse(await readFile(join(dir, 'data/operations.json'), 'utf8')) as State;
      assert.equal(state.bootstrapFinished, false);
      const done = once(child, 'exit');
      child.kill('SIGINT');
      assert.equal((await done)[0], 0, output);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const done = once(child, 'exit');
        child.kill('SIGKILL');
        await done;
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);
