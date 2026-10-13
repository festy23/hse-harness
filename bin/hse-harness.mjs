#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';

// Select user-owned paths before importing dotenv or any application module.
const home = resolve(process.env.HSE_HARNESS_HOME || join(homedir(), '.hse-harness'));
process.env.HSE_HARNESS_HOME = home;
for (const [key, filename] of Object.entries({
  DOTENV_CONFIG_PATH: '.env', STUDY_CONFIG: 'config.local.json',
  STUDY_DATA_DIR: 'data', STUDY_SECRETS_DIR: 'secrets',
})) process.env[key] = resolve(process.env[key] || join(home, filename));

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error('HSE HARNESS: нужен Node.js 22.19.0 или новее вместе с npm.');
  process.exitCode = 1;
} else {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--version' || args[0] === '-v') {
      const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      console.log(metadata.version);
    } else if (args[0] === 'paths') {
      if (args.length !== 1) throw new Error('Использование: hse-harness paths');
      console.log(JSON.stringify({ home, config: process.env.STUDY_CONFIG, env: process.env.DOTENV_CONFIG_PATH,
        data: process.env.STUDY_DATA_DIR, secrets: process.env.STUDY_SECRETS_DIR }, null, 2));
    } else if (args[0] === 'run') {
      if (args.length !== 1) throw new Error('Использование: hse-harness run');
      await import('../dist/main.js');
    } else if (args[0] === 'service') {
      const { serviceCLI } = await import('../dist/cli/system-service.js');
      process.exitCode = await serviceCLI(args.slice(1));
    } else if (args[0] === 'updates') {
      const { updatesCLI } = await import('../dist/cli/updates.js');
      process.exitCode = await updatesCLI(args.slice(1));
    } else if (args[0] === 'import') {
      if (args.length !== 2) throw new Error('Использование: hse-harness import /путь/к/старой/установке');
      const { importInstallation } = await import('../dist/cli/import-installation.js');
      await importInstallation(resolve(args[1]), home);
      console.log(`Настройки, авторизация и память перенесены в ${home}. Проверка: hse-harness status`);
    } else {
      const { main } = await import('../dist/cli.js');
      await main(args[0] === 'setup' ? ['configure', ...args.slice(1)] : args);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Не удалось выполнить команду HSE HARNESS.');
    process.exitCode = 1;
  }
}
