import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess, runningPid } from './service.js';
import { SetupIssue } from './errors.js';
import { SetupState } from './state.js';

const unitName = 'hse-harness.service';

/** Quote systemd arguments, including its % specifier and $ environment expansion. */
function quote(value: string, executable = false): string {
  if (/[\r\n\0]/.test(value)) throw new SetupIssue('Путь содержит неподдерживаемый символ');
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return '"' + (executable ? escaped.replaceAll('$', () => '$$') : escaped) + '"';
}

export function serviceUnit(options: { node: string; executable: string; home: string; uid: number; gid: number; paths: Record<string, string> }): string {
  if (!Number.isSafeInteger(options.uid) || options.uid <= 0 || !Number.isSafeInteger(options.gid) || options.gid < 0) {
    throw new SetupIssue('Устанавливай бота от отдельного непривилегированного пользователя, например study');
  }
  const environment = { NODE_ENV: 'production', HSE_HARNESS_HOME: options.home, ...options.paths };
  return `[Unit]
Description=HSE HARNESS study assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${options.uid}
Group=${options.gid}
WorkingDirectory=${options.home.replaceAll('%', '%%')}
ExecStart=${quote(options.node, true)} ${quote(options.executable, true)} run
${Object.entries(environment).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`).join('\n')}
Restart=on-failure
RestartSec=10
TimeoutStopSec=90
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

export async function serviceCLI(args: string[]): Promise<number> {
  const [action, flag] = args;
  if (!['install', 'status', 'logs', 'stop', 'restart', 'uninstall'].includes(action ?? '') ||
      args.length > 2 || (flag && !(action === 'install' && flag === '--dry-run'))) {
    throw new SetupIssue('Использование: hse-harness service install [--dry-run] | status | logs | stop | restart | uninstall');
  }
  if (process.platform !== 'linux' && flag !== '--dry-run') throw new SetupIssue('Системный сервис поддерживается на Linux с systemd. Локальный запуск: hse-harness start');
  const user = userInfo();
  const root = user.uid === 0;
  const systemctl = async (values: string[]) => runProcess(root ? 'systemctl' : 'sudo', root ? values : ['systemctl', ...values], process.cwd());
  if (action === 'logs') return runProcess(root ? 'journalctl' : 'sudo', [...(root ? [] : ['journalctl']), '-u', unitName, '-f'], process.cwd());
  if (action === 'status' || action === 'stop' || action === 'restart') return systemctl([action, unitName]);
  if (action === 'uninstall') {
    const disabled = await systemctl(['disable', '--now', unitName]);
    if (disabled !== 0) return disabled;
    const removed = await runProcess(root ? 'rm' : 'sudo', [...(root ? [] : ['rm']), '-f', `/etc/systemd/system/${unitName}`], process.cwd());
    return removed === 0 ? systemctl(['daemon-reload']) : removed;
  }
  const home = process.env.HSE_HARNESS_HOME;
  if (!home) throw new SetupIssue('Установка сервиса доступна через установленную npm-команду hse-harness');
  const paths = Object.fromEntries(['DOTENV_CONFIG_PATH', 'STUDY_CONFIG', 'STUDY_DATA_DIR', 'STUDY_SECRETS_DIR'].map(key => [key, process.env[key]! ]));
  const unit = serviceUnit({ node: process.execPath, executable: fileURLToPath(new URL('../../bin/hse-harness.mjs', import.meta.url)), home, uid: user.uid, gid: user.gid, paths });
  if (flag === '--dry-run') { console.log(unit); return 0; }
  if (process.env.npm_command === 'exec') throw new SetupIssue('Для постоянного сервиса установи пакет через npm install -g @ivan-boss/hse-harness, затем повтори команду. Не используй временный кэш npx.');
  const state = new SetupState(); await state.load();
  if (!state.config.ownerId || !process.env.TELEGRAM_BOT_TOKEN) throw new SetupIssue('Сначала подключи Telegram: hse-harness telegram');
  if (await runningPid()) throw new SetupIssue('Перед установкой сервиса останови ручной экземпляр бота');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(tmpdir(), 'hse-service-'));
  try {
    const file = join(staging, unitName); await writeFile(file, unit, { mode: 0o600 });
    const installed = await runProcess('sudo', ['install', '-m', '644', file, `/etc/systemd/system/${unitName}`], process.cwd());
    if (installed !== 0) return installed;
    const reloaded = await systemctl(['daemon-reload']);
    if (reloaded !== 0) return reloaded;
    const enabled = await systemctl(['enable', '--now', unitName]);
    if (enabled === 0) console.log('HSE HARNESS установлен как сервис. Проверка: hse-harness service status');
    return enabled;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
