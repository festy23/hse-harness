import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test(
  'fatal Store rejection stops sibling loops, emits correlated fatal and releases writer lock',
  { timeout: 15000 },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'worker-fatal-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const config = join(folder, 'config.json'),
        preload = join(folder, 'preload.mjs');
      await writeFile(join(folder, '.env'), '');
      await writeFile(
        config,
        JSON.stringify({
          ownerId: 1,
          chats: [],
          features: { googleCalendar: false, icloudCalendar: true },
          calendars: {
            timetable: { provider: 'icloud', id: 'https://caldav.icloud.com/schedule/' },
            agent: { provider: 'icloud', id: 'https://caldav.icloud.com/agent/' },
          },
          folders: [],
          model: '',
          pollSeconds: 15,
        }),
      );
      const storeURL = new URL('../src/store.ts', import.meta.url).href;
      await writeFile(
        preload,
        `import {Store} from ${JSON.stringify(storeURL)};\nconst original=Store.prototype.save;let writes=0;Store.prototype.save=function(){if(++writes>1)return Promise.reject(new Error('Injected writer invariant'));return original.call(this);};globalThis.fetch=async()=>{throw new Error('Fixture provider unavailable');};`,
      );
      child = spawn(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), '--import', preload, resolve('src/main.ts')],
        {
          cwd: folder,
          env: {
            ...process.env,
            DOTENV_CONFIG_PATH: join(folder, '.env'),
            STUDY_CONFIG: config,
            STUDY_DATA_DIR: join(folder, 'data'),
            STUDY_SECRETS_DIR: join(folder, 'secrets'),
            HSE_WORKER_ID: 'fatal-test',
            HSE_RELEASE_VERSION: '0.2.0',
            TELEGRAM_BOT_TOKEN: '1:fixture',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      let output = '';
      child.stdout?.on('data', (b) => {
        output += b;
      });
      child.stderr?.on('data', (b) => {
        output += b;
      });
      const messages: Record<string, unknown>[] = [];
      child.on('message', (m) => messages.push(m as Record<string, unknown>));
      const ended = once(child, 'exit');
      const command = (type: string, sequence: number) =>
        child!.send({
          protocolVersion: 1,
          attemptId: 'fatal-attempt',
          workerId: 'fatal-test',
          sequence,
          type,
        });
      const ready = new Promise<void>((resolveReady, reject) => {
        const handle = (m: unknown) => {
          const packet = m as { type?: string };
          if (packet.type === 'boot-ready') {
            child!.off('message', handle);
            resolveReady();
          } else if (packet.type === 'boot-failed') {
            child!.off('message', handle);
            reject(new Error('Prepare failed ' + output));
          }
        };
        child!.on('message', handle);
      });
      command('prepare', 1);
      await ready;
      command('activate', 2);
      let timer: NodeJS.Timeout | undefined;
      const [code] = await Promise.race([
        ended,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Worker failed to exit after fatal: ' + output)),
            5000,
          );
        }),
      ]).finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
      });
      assert.equal(code, 1, output);
      const fatal = messages.find((m) => m.type === 'fatal');
      assert.ok(fatal, JSON.stringify(messages));
      assert.equal(fatal.workerId, 'fatal-test');
      assert.equal(fatal.attemptId, 'fatal-attempt');
      assert.equal(fatal.sequence, 2);
      assert.equal(fatal.code, 'state-invariant');
      await assert.rejects(access(join(folder, 'data', 'service.lock')), { code: 'ENOENT' });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const done = once(child, 'exit');
        child.kill('SIGKILL');
        await done;
      }
      await rm(folder, { recursive: true, force: true });
    }
  },
);
