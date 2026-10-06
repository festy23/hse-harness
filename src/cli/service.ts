import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dataDir } from '../config.js';
import { SetupIssue } from './errors.js';
import type { SetupConfig } from './state.js';
import { runProcess as executeProcess } from '../../scripts/process.mjs';

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

/** Bootstrap installation and service launch share the same subprocess lifecycle. */
export const runProcess: ProcessRunner = async (command, args, root) => {
  try { return await executeProcess(command, args, root); }
  catch (error) { throw new SetupIssue((error as Error).message); }
};

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
