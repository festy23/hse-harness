import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { dataDir } from '../config.js';
import { SetupIssue } from './errors.js';
import type { SetupConfig } from './state.js';

export type ProcessRunner = (command: string, args: string[], root: string) => Promise<number>;
export async function runningPid(dir = dataDir()): Promise<number | undefined> {
  let value: string;
  try { value = await readFile(join(dir, 'service.lock'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new SetupIssue('Не удалось проверить состояние процесса бота');
  }
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 0); return pid; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return pid;
    throw error;
  }
}

/** A separate Unix process group receives one forwarded interrupt, so shutdown is graceful. */
export const runProcess: ProcessRunner = (command, args, root) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env, detached: process.platform !== 'win32' });
  let interrupted = false;
  const signal = (value: NodeJS.Signals) => {
    if (interrupted || child.pid === undefined) return;
    interrupted = true;
    try {
      if (process.platform === 'win32') child.kill(value);
      else process.kill(-child.pid, value);
    } catch (error) {
      // The child group may have exited between receiving the interrupt and forwarding it.
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      cleanup();
      reject(new SetupIssue('Не удалось передать остановку процессу бота'));
    }
  };
  const interrupt = () => signal('SIGINT');
  const terminate = () => signal('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
  child.once('error', () => { cleanup(); reject(new SetupIssue('Не удалось запустить процесс. Проверь Node.js и npm')); });
  child.once('exit', (code, killedBy) => {
    cleanup();
    resolve(code ?? (killedBy === 'SIGINT' ? 130 : killedBy === 'SIGTERM' ? 143 : 1));
  });
});

export type StartResult = { kind: 'already-running'; pid: number } | { kind: 'stopped'; code: number };
export class ServiceControl {
  constructor(readonly root = process.cwd(), readonly runner: ProcessRunner = runProcess, readonly pid: () => Promise<number | undefined> = () => runningPid(resolve(root, process.env.STUDY_DATA_DIR ?? 'data'))) {}
  async start(config: SetupConfig, notify: (message: string) => void): Promise<StartResult> {
    const existing = await this.pid();
    if (existing) return { kind: 'already-running', pid: existing };
    const missing = [!config.ownerId && 'владелец Telegram', !process.env.TELEGRAM_BOT_TOKEN && 'токен Telegram-бота'].filter(Boolean);
    if (missing.length) throw new SetupIssue(`Запуск невозможен: ${missing.join(', ')}. Подключи Telegram через меню`);
    notify('Собираю проект…');
    const built = await this.runner(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], this.root);
    if (built !== 0) throw new SetupIssue('Сборка завершилась с ошибкой. Бот не запущен');
    notify('Бот запускается. Остановка — Ctrl+C. Личный диалог — через /start в Telegram.');
    const code = await this.runner(process.execPath, [join(this.root, 'dist/main.js')], this.root);
    return { kind: 'stopped', code };
  }
}
