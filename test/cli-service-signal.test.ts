import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

test('service runner forwards one interruption to a complete Unix child group and awaits graceful shutdown', { skip: process.platform === 'win32', timeout: 25_000 }, async () => {
  const result = await new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    const child = spawn('python3', ['-B', resolve('test/cli/service_checks.py'), resolve('.'), process.execPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('error', reject);
    child.once('exit', code => resolveResult({ code, output }));
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /PASS CLI SERVICE SIGNALS/);
});
