import { lstat, mkdir, readdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeSetupConfig } from './state.js';
import { SetupIssue } from './errors.js';
import { runningPid } from './service.js';

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function importInstallation(source: string, destination: string): Promise<void> {
  source = resolve(source);
  destination = resolve(destination);
  const nested = relative(source, destination);
  if (source === destination || (nested && !nested.startsWith('..') && !isAbsolute(nested))) {
    throw new SetupIssue('Каталог назначения должен находиться вне старой установки');
  }
  if (await exists(destination)) {
    throw new SetupIssue(
      'Каталог назначения уже существует. Импорт не перезаписывает существующие настройки; выбери пустой HSE_HARNESS_HOME.',
    );
  }
  if (await runningPid(join(source, 'data'))) {
    throw new SetupIssue(
      'Перед переносом останови старого бота. Импорт требует согласованной копии его состояния.',
    );
  }
  const config = normalizeSetupConfig(
    JSON.parse(await readFile(join(source, 'config.local.json'), 'utf8')),
  );
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = destination + '.import-' + randomUUID();
  const copy = async (from: string, to: string): Promise<void> => {
    const info = await lstat(from);
    if (info.isSymbolicLink()) {
      throw new SetupIssue(
        'Импорт не поддерживает символические ссылки в данных; перенеси обычные файлы',
      );
    }
    if (info.isDirectory()) {
      await mkdir(to, { mode: 0o700 });
      for (const name of await readdir(from)) {
        if (from === join(source, 'data') && ['service.lock', 'e2e'].includes(name)) {
          continue;
        }
        await copy(join(from, name), join(to, name));
      }
    } else if (info.isFile()) {
      await writeFile(to, await readFile(from), { mode: 0o600, flag: 'wx' });
    } else {
      throw new SetupIssue('В копии данных найден неподдерживаемый тип файла');
    }
  };
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const name of ['.env', 'data', 'secrets']) {
      if (await exists(join(source, name))) {
        await copy(join(source, name), join(staging, name));
      }
    }
    await writeFile(join(staging, 'config.local.json'), JSON.stringify(config, null, 2) + '\n', {
      mode: 0o600,
    });
    const operations = join(staging, 'data', 'operations.json');
    if (await exists(operations)) {
      const state = JSON.parse(await readFile(operations, 'utf8')) as { sessionPath?: string };
      if (state.sessionPath) {
        const filename = basename(state.sessionPath);
        const session = join(staging, 'data', 'sessions', filename);
        if (!filename.endsWith('.jsonl') || !(await exists(session))) {
          throw new SetupIssue(
            'В копии отсутствует сохранённая Pi-сессия. Импорт отменён, чтобы не потерять память.',
          );
        }
        state.sessionPath = join(destination, 'data', 'sessions', filename);
        await writeFile(operations, JSON.stringify(state), { mode: 0o600 });
      }
    }

    if (await exists(destination)) {
      throw new SetupIssue(
        'Во время импорта создан каталог назначения; прежние данные не изменены',
      );
    }
    await rename(staging, destination);
    await chmod(destination, 0o700);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
