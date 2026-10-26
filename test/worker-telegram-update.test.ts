import type { State } from '../src/store.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test(
  'managed worker offers and installs by Bot API button while calendar/model startup is unavailable',
  { timeout: 25000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hse-worker-update-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const home = join(dir, 'home'),
        manifestPath = join(dir, 'prefix/lib/node_modules/@ivan-boss/hse-harness/package.json');
      await mkdir(join(home, 'runtime'), { recursive: true });
      await mkdir(join(dir, 'prefix/lib/node_modules/@ivan-boss/hse-harness'), { recursive: true });
      const manifest = {
        protocolVersion: 1,
        stateSchemaVersion: 2,
        piVersion: '1.0.2',
        minSupervisorVersion: '1.0.0',
        formats: { operations: 2, auth: 1 },
        writableStateVersion: 2,
      };
      const integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
      await writeFile(manifestPath, JSON.stringify({ version: '0.2.2' }));
      await writeFile(
        join(home, 'runtime/state.json'),
        JSON.stringify({
          installation: { manifestPath },
          active: { version: '0.2.2', manifest },
          runningVersion: '0.2.2',
          supervisorVersion: '1.0.0',
          quarantine: [],
        }),
      );
      await writeFile(join(home, 'runtime/settings.json'), JSON.stringify({ enabled: true }));
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
      const npm = join(dir, 'npm');
      await writeFile(
        npm,
        `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(manifestPath)},JSON.stringify({version:'0.2.3'}));fs.appendFileSync(${JSON.stringify(join(dir, 'install-count'))},'installed\\n');`,
        { mode: 0o700 },
      );
      const url = (path: string) => new URL('../' + path, import.meta.url).href;
      const preload = `import {appendFile} from 'node:fs/promises';
import {ICloudAccount} from ${JSON.stringify(url('src/calendar/providers/icloud.ts'))};
import {TelegramSource} from ${JSON.stringify(url('src/telegram.ts'))};
import {ReleaseStore} from ${JSON.stringify(url('runtime/releases.mjs'))};
TelegramSource.prototype.close=async()=>{};
ICloudAccount.prototype.collection=async()=>{throw Error('Calendar unavailable');};
ReleaseStore.prototype.prepare=async()=>({version:'0.2.3',integrity:${JSON.stringify(integrity)},manifest:${JSON.stringify(manifest)}});
let button,sent=false;
globalThis.fetch=async(input,options)=>{
 const u=new URL(input);if(u.hostname==='registry.npmjs.org')return Response.json({'dist-tags':{latest:'0.2.3'},versions:{'0.2.3':{name:'@ivan-boss/hse-harness',version:'0.2.3',dist:{integrity:${JSON.stringify(integrity)},tarball:'https://registry.npmjs.org/pkg.tgz'}}}});
 const method=u.pathname.split('/').at(-1),args=JSON.parse(options.body);
 if(method==='getUpdates'){await new Promise(r=>setTimeout(r,50));if(button&&!sent){sent=true;return Response.json({ok:true,result:[{update_id:1,callback_query:{id:'one',from:{id:1},message:{chat:{id:1,type:'private'}},data:button}},{update_id:2,callback_query:{id:'two',from:{id:1},message:{chat:{id:1,type:'private'}},data:button}}]});}return Response.json({ok:true,result:[]});}
 if(method==='sendMessage'){await appendFile(${JSON.stringify(join(dir, 'sent.jsonl'))},JSON.stringify(args)+'\\n');button??=args.reply_markup?.inline_keyboard[0][0].callback_data;return Response.json({ok:true,result:{message_id:1}});}
 if(method==='answerCallbackQuery')return Response.json({ok:true,result:true});
 throw Error('Unexpected network request');
};`;
      await writeFile(join(dir, 'preload.mjs'), preload);
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
            npm_execpath: npm,
            HSE_HARNESS_HOME: home,
            HSE_RELEASE_VERSION: '0.2.2',
            HSE_WORKER_ID: 'test-worker',
            DOTENV_CONFIG_PATH: join(dir, '.env'),
            STUDY_CONFIG: join(dir, 'config.json'),
            STUDY_DATA_DIR: join(dir, 'data'),
            STUDY_SECRETS_DIR: join(dir, 'secrets'),
            TELEGRAM_BOT_TOKEN: '1:fixture',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      let output = '';
      child.stdout?.on('data', (b) => (output += b));
      child.stderr?.on('data', (b) => (output += b));
      child.on('message', (message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'boot-ready'
        ) {
          child!.send({
            protocolVersion: 1,
            attemptId: 'boot',
            workerId: 'test-worker',
            sequence: 2,
            type: 'activate',
          });
        }
      });
      child.send({
        protocolVersion: 1,
        attemptId: 'boot',
        workerId: 'test-worker',
        sequence: 1,
        type: 'prepare',
      });
      let state: State | undefined;
      const until = Date.now() + 18000;
      while (Date.now() < until) {
        state = await readFile(join(dir, 'data/operations.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => undefined);
        if (state?.npmUpdates?.request?.phase === 'awaiting-apply' && state.botOffset === 3) {
          break;
        }
        await new Promise((r) => {
          setTimeout(r, 40);
        });
      }
      assert.ok(state);
      assert.equal(state.npmUpdates?.request?.phase, 'awaiting-apply', output);
      assert.equal(state.botOffset, 3);
      assert.equal(state.health['Календарь'], 'unavailable');
      assert.equal(state.health['Бот'], 'ok');
      assert.equal(await readFile(join(dir, 'install-count'), 'utf8'), 'installed\n');
      const sent = (await readFile(join(dir, 'sent.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              text: string;
              reply_markup?: { inline_keyboard: { text: string }[][] };
            },
        );
      assert.ok(sent.some((x) => x.reply_markup?.inline_keyboard[0]?.[0]?.text === 'Обновить'));
      assert.ok(sent.some((x) => x.text.includes('Запускаю обновление')));
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
