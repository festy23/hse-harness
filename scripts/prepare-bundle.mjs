import { readFile, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
let normalized = 0;
// npm's bundled extraction may drop a bin hardlink when its platform package is reified.
// Preserve the exact executable bytes but make every bundled bin a standalone file.
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!entry.inBundle || !entry.bin) continue;
  const binaries = typeof entry.bin === 'string' ? [entry.bin] : Object.values(entry.bin);
  for (const binary of binaries) {
    const file = resolve(root, location, binary);
    if (!file.startsWith(join(root, 'node_modules') + sep)) throw new Error('Некорректный путь bin зависимости');
    let info;
    try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isSymbolicLink() && info.nlink <= 1) continue;
    const content = await readFile(file);
    const temp = file + '.hse-pack-' + randomUUID();
    try {
      await writeFile(temp, content, { mode: 0o755, flag: 'wx' });
      await rename(temp, file);
      normalized++;
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
console.log(`Готовые runtime-зависимости: нормализовано исполняемых файлов ${normalized}.`);
