import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export async function findNpm() {
  const candidates = [
    process.env.npm_execpath,
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(isAbsolute)
      .map((path) => join(path, 'npm')),
  ];
  for (const path of candidates) {
    if (!path || !isAbsolute(path)) {
      continue;
    }
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {}
  }
  throw new Error('npm не найден; установи Node.js вместе с npm');
}
