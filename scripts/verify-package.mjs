import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (metadata.name !== '@ivan-boss/hse-harness' || metadata.private) {
  throw new Error('Неверные параметры публичного пакета');
}
const result = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);
if (result.status !== 0) {
  throw new Error('Не удалось проверить состав npm-пакета');
}
const parsed = JSON.parse(result.stdout);
const [{ files }] = Array.isArray(parsed) ? parsed : Object.values(parsed);
const paths = files.map((file) => file.path);
for (const path of paths.filter((path) => !path.startsWith('node_modules/'))) {
  if (
    /(^|\/)(data|secrets|node_modules|src|test|\.git)(\/|$)/.test(path) ||
    (/(^|\/)\.env(\.|$)/.test(path) && path !== '.env.example') ||
    /(^|\/)(config\.local\.json|operations\.json|telegram\.session|pi-auth\.json|google\.json)$/.test(
      path,
    )
  ) {
    throw new Error(`В npm-пакет попал локальный файл: ${path}`);
  }
}
for (const path of [
  'bin/hse-harness.mjs',
  'dist/cli.js',
  'dist/main.js',
  'dist/cli/system-service.js',
  'dist/cli/import-installation.js',
  'scripts/process.mjs',
  'runtime/supervisor.mjs',
  'runtime/installation.mjs',
  'runtime/releases.mjs',
  'runtime-manifest.json',
  'docs/research/hse-software-engineering-bpi243.md',
  'node_modules/@earendil-works/pi-coding-agent/package.json',
  'node_modules/@earendil-works/pi-codemode/package.json',
]) {
  if (!paths.includes(path)) {
    throw new Error(`В npm-пакете отсутствует ${path}`);
  }
}
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
for (const file of paths.filter(
  (path) => path.startsWith('node_modules/') && path.endsWith('/package.json'),
)) {
  const location = file.slice(0, -'/package.json'.length);
  if (!lock.packages[location]) {
    continue;
  }
  const actual = JSON.parse(readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
  if (actual.version !== lock.packages[location].version) {
    throw new Error(`Зависимость не соответствует lockfile: ${location}`);
  }
}
console.log(
  `Пакет проверен: ${paths.length} файлов с закреплёнными runtime-зависимостями; личные данные исключены.`,
);
