import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

test('native launcher works through a symlink with spaces from another directory and preserves command exit codes', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hse bootstrap '));
  const alias = join(root, 'checkout link');
  try {
    await symlink(resolve('.'), alias, 'dir');
    const run = (command: string) => new Promise<{ code: number | null; output: string }>((done, reject) => {
      const child = spawn(process.execPath, [join(alias, 'scripts/harness.mjs'), command], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('close', code => done({ code, output }));
    });
    const help = await run('help'); assert.equal(help.code, 0); assert.match(help.output, /HSE HARNESS/);
    assert.doesNotMatch(help.output, /устанавливаю зависимости/);
    const invalid = await run('unknown'); assert.equal(invalid.code, 1); assert.match(invalid.output, /Неизвестная команда/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
