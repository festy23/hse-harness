import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcess } from './process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const stamp = join(root, 'node_modules', '.hse-harness-lock');

function supportedNode(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

async function optional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
}

/** Adopt a normal npm ci installation without reinstalling packages used by a running bot. */
async function installed(packageJSON, lock, fingerprint) {
  const direct = { ...packageJSON.dependencies, ...packageJSON.devDependencies };
  for (const name of Object.keys(direct)) {
    const text = await optional(join(root, 'node_modules', name, 'package.json'));
    if (!text || JSON.parse(text).version !== lock.packages[`node_modules/${name}`]?.version) return false;
  }
  const saved = await optional(stamp);
  if (saved !== undefined) return saved === fingerprint;
  const text = await optional(join(root, 'node_modules', '.package-lock.json'));
  if (!text) return false;
  const existing = JSON.parse(text).packages ?? {};
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || (entry.optional && !existing[path])) continue;
    if (existing[path]?.version !== entry.version || existing[path]?.integrity !== entry.integrity) return false;
  }
  return true;
}

async function prepare() {
  const contents = await readFile(join(root, 'package-lock.json'), 'utf8');
  const lock = JSON.parse(contents);
  const packageJSON = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const fingerprint = createHash('sha256').update(contents).digest('hex');
  if (!await installed(packageJSON, lock, fingerprint)) {
    console.log('HSE HARNESS · устанавливаю зависимости, включая Pi…');
    const options = ['ci', '--include=dev', '--no-audit', '--no-fund'];
    const npmCLI = process.env.npm_execpath;
    const command = npmCLI ? process.execPath : process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
    const args = npmCLI ? [npmCLI, ...options] : process.platform === 'win32' ? ['/d', '/s', '/c', `npm ${options.join(' ')}`] : options;
    const code = await runProcess(command, args, root);
    if (code) {
      process.exitCode = code;
      if (code !== 130 && code !== 143) console.error('Установка не завершена. Проверь интернет и npm, затем повтори запуск.');
      return false;
    }
  }
  if (await optional(stamp) !== fingerprint) await writeFile(stamp, fingerprint, { mode: 0o600 });
  return true;
}

export async function main(args = process.argv.slice(2)) {
  if (!supportedNode(process.versions.node)) {
    console.error(`HSE HARNESS: нужен Node.js 22.19.0 или новее; сейчас ${process.versions.node}. Установи Node.js вместе с npm.`);
    process.exitCode = 1;
    return;
  }
  process.chdir(root);
  if (!await prepare()) return;
  // Load the TypeScript CLI in this process: TTY and the existing shutdown lifecycle stay intact.
  const { tsImport } = await import('tsx/esm/api');
  const cli = await tsImport('../src/cli.ts', import.meta.url);
  await cli.main(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main().catch(() => {
    console.error('HSE HARNESS: не удалось подготовить запуск. Проверь файлы проекта, права доступа и установку Node.js/npm.');
    process.exitCode = 1;
  });
}
