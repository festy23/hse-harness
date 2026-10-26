import { isRecord } from '../validation.js';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { SetupIssue } from './errors.js';

export interface RuntimeStatus {
  installedVersion?: string;
  runningVersion?: string;
  supervisorVersion?: string;
  updatesEnabled?: boolean;
  phase?: string;
  pendingVersion?: string;
  deferredReason?: string;
  lastSuccessfulSwitch?: unknown;
  quarantine?: unknown;
  manualHold?: { version?: string };
}
interface RuntimeAPI {
  installRuntime(options: {
    home: string;
    packageRoot: string;
    node?: string;
  }): Promise<{ launcher: string }>;
  readRuntimeStatus(home: string): Promise<RuntimeStatus>;
  updateSettings(home: string, change: { enabled: boolean }): Promise<unknown>;
  requestUpdate(home: string, request: { action: 'retry' | 'rollback' }): Promise<unknown>;
}

export function managedHome(): string {
  return resolve(process.env.HSE_HARNESS_HOME || join(homedir(), '.hse-harness'));
}

export function managedInstallation(packageRoot: string, env = process.env): boolean {
  const root = resolve(packageRoot);
  if (env.npm_command === 'exec' || root.split(sep).includes('_npx')) {
    return false;
  }
  return root.endsWith(join('lib', 'node_modules', '@ivan-boss', 'hse-harness'));
}

export async function runtimeAPI(): Promise<RuntimeAPI> {
  return (await import(
    new URL('../../runtime/installation.mjs', import.meta.url).href
  )) as RuntimeAPI;
}

export function formatRuntimeStatus(status: RuntimeStatus): string {
  const lines = [
    `Установлена через npm: ${status.installedVersion ?? 'не определена'}`,
    `Работающая версия: ${status.runningVersion ?? 'бот остановлен'}`,
    `Supervisor: ${status.supervisorVersion ?? 'не установлен'}`,
    `Автоматическое применение: ${status.updatesEnabled ? (status.supervisorVersion ? '✅ включено' : 'ожидает первоначального запуска supervisor') : '❌ выключено'}`,
    `Этап: ${status.phase ?? 'режим ещё не установлен'}`,
  ];
  if (status.pendingVersion) {
    lines.push(`Ожидающая версия: ${status.pendingVersion}`);
  }
  if (status.deferredReason) {
    lines.push(`Причина ожидания: ${status.deferredReason}`);
  }
  if (status.manualHold?.version) {
    lines.push(
      `После ручного отката версия ${status.manualHold.version} не применяется повторно; команда updates retry снимает удержание.`,
    );
  }
  if (Array.isArray(status.quarantine)) {
    for (const entry of status.quarantine) {
      if (
        isRecord(entry) &&
        typeof entry.version === 'string' &&
        typeof entry.reason === 'string'
      ) {
        lines.push(
          `Выпуск ${entry.version} заблокирован: ${entry.reason}. Повторить: hse-harness updates retry`,
        );
      }
    }
  }
  if (typeof status.lastSuccessfulSwitch === 'string') {
    lines.push(`Последнее переключение: ${status.lastSuccessfulSwitch}`);
  } else if (status.lastSuccessfulSwitch && typeof status.lastSuccessfulSwitch === 'object') {
    const switchInfo = status.lastSuccessfulSwitch as Record<string, unknown>;
    if (typeof switchInfo.from === 'string' && typeof switchInfo.to === 'string') {
      lines.push(`Последнее переключение: ${switchInfo.from} → ${switchInfo.to}`);
    }
  }
  return lines.join('\n');
}

export async function installedRuntimeStatus(
  home = managedHome(),
  api?: Pick<RuntimeAPI, 'readRuntimeStatus'>,
): Promise<RuntimeStatus> {
  const runtime = api ?? (await runtimeAPI());
  const status = await runtime.readRuntimeStatus(home);

  const metadata = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return { ...status, installedVersion: metadata.version };
}

export async function updatesCLI(
  args: string[],
  options: {
    home?: string;
    packageRoot?: string;
    print?: (message: string) => void;
    api?: RuntimeAPI;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  const [action] = args;
  if (
    args.length !== 1 ||
    !['status', 'enable', 'disable', 'retry', 'rollback'].includes(action ?? '')
  ) {
    throw new SetupIssue(
      'Использование: hse-harness updates status | enable | disable | retry | rollback',
    );
  }
  const home = options.home ?? managedHome();
  const print = options.print ?? console.log;
  const api = options.api ?? (await runtimeAPI());
  if (action === 'status') {
    print(formatRuntimeStatus(await installedRuntimeStatus(home, api)));
    return 0;
  }
  if ((options.platform ?? process.platform) === 'win32') {
    throw new SetupIssue(
      'Автоматическое применение обновлений поддерживается на macOS/Linux. На Windows используй обычный запуск.',
    );
  }
  const packageRoot = options.packageRoot ?? fileURLToPath(new URL('../../', import.meta.url));
  if (!managedInstallation(packageRoot, options.env ?? process.env)) {
    throw new SetupIssue(
      'Управление обновлениями доступно из постоянной npm-установки. Выполни npm install -g @ivan-boss/hse-harness; npx и исходники не включают этот режим.',
    );
  }
  if (action === 'enable' || action === 'disable') {
    await api.updateSettings(home, { enabled: action === 'enable' });
    print(
      action === 'enable'
        ? 'Автоматическое применение включено. Если supervisor ещё не установлен, запусти hse-harness start или hse-harness service install. Работающая 0.1.0 требует одной первоначальной остановки.'
        : 'Автоматическое применение выключено. Текущая версия продолжает работать.',
    );
  } else {
    await api.requestUpdate(home, { action: action as 'retry' | 'rollback' });
    print(
      action === 'retry'
        ? 'Запрос повторной подготовки сохранён для supervisor. Проверка: hse-harness updates status'
        : 'Запрос отката сохранён для supervisor. Проверка: hse-harness updates status',
    );
  }
  return 0;
}
