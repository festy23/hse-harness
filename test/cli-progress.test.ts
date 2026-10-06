import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const progressUrl = pathToFileURL(resolve('src/cli/progress.ts')).href;
const errorsUrl = pathToFileURL(resolve('src/cli/errors.ts')).href;

async function childCheck(body: string, interrupt?: NodeJS.Signals): Promise<string> {
  const source = `
    import assert from 'node:assert/strict';
    import { withProgress } from ${JSON.stringify(progressUrl)};
    import { SetupCancelled } from ${JSON.stringify(errorsUrl)};
    // Model an active connection: a bare promise does not keep Node alive for an external signal.
    const connection = setInterval(() => {}, 1000);
    try { ${body} } finally { clearInterval(connection); }
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  let sent = false;
  child.stdout.on('data', chunk => {
    output += String(chunk);
    if (interrupt && !sent && output.includes('ACTION STARTED')) {
      sent = true;
      child.kill(interrupt);
    }
  });
  child.stderr.on('data', chunk => { errors += String(chunk); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null, `child killed by ${signal}; ${errors}`);
    assert.equal(code, 0, errors);
    if (interrupt) assert.equal(sent, true, 'signal was not sent to the child');
    return output;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

test('Progress returns an action value, preserves errors and restores signal listeners', async () => {
  const output = await childCheck(`
    const initialInt = process.listenerCount('SIGINT');
    const initialTerm = process.listenerCount('SIGTERM');
    assert.equal(await withProgress('Успешная проверка', async signal => {
      assert.equal(signal.aborted, false);
      return 42;
    }), 42);
    const failure = new Error('fixture error');
    await assert.rejects(withProgress('Неуспешная проверка', async () => { throw failure; }), error => error === failure);
    assert.equal(process.listenerCount('SIGINT'), initialInt);
    assert.equal(process.listenerCount('SIGTERM'), initialTerm);
  `);
  assert.match(output, /✓ Успешная проверка/);
  assert.match(output, /Проверка не завершена/);
});

for (const interrupt of ['SIGINT', 'SIGTERM'] as const) {
  test(`Progress ${interrupt} waits for action cleanup and converts a late success into cancellation`, async () => {
    const output = await childCheck(`
      const initialInt = process.listenerCount('SIGINT');
      const initialTerm = process.listenerCount('SIGTERM');
      let cleaned = false;
      await assert.rejects(withProgress('Проверка с отменой', async signal => {
        console.log('ACTION STARTED');
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        await new Promise(resolve => setTimeout(resolve, 30));
        cleaned = true;
        console.log('ACTION CLEANED');
        return 'late success';
      }), error => error instanceof SetupCancelled);
      assert.equal(cleaned, true, 'UI returned before action cleanup');
      assert.equal(process.listenerCount('SIGINT'), initialInt);
      assert.equal(process.listenerCount('SIGTERM'), initialTerm);
      console.log('CANCELLATION CAUGHT');
    `, interrupt);
    assert.match(output, /Отменяю проверку/);
    assert.match(output, /Проверка отменена/);
    assert.ok(output.indexOf('ACTION CLEANED') < output.indexOf('CANCELLATION CAUGHT'));
    assert.doesNotMatch(output, /✓ Проверка с отменой/);
  });
}

test('Progress cancellation preserves cleanup when an action rejects after abort', async () => {
  const output = await childCheck(`
    let cleaned = false;
    await assert.rejects(withProgress('Прерываемая проверка', async signal => {
      console.log('ACTION STARTED');
      try {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('native abort error')), { once: true }));
      } finally { cleaned = true; console.log('ACTION CLEANED'); }
    }), error => error instanceof SetupCancelled);
    assert.equal(cleaned, true);
    console.log('CANCELLATION CAUGHT');
  `, 'SIGINT');
  assert.match(output, /CANCELLATION CAUGHT/);
  assert.doesNotMatch(output, /✓ Прерываемая проверка/);
});

test('Progress waits for an adapter that ignores its abort signal before returning cancellation', async () => {
  const output = await childCheck(`
    let lateWriteFinished = false;
    await assert.rejects(withProgress('Проверка без поддержки abort', async () => {
      console.log('ACTION STARTED');
      await new Promise(resolve => setTimeout(resolve, 80));
      lateWriteFinished = true;
      console.log('LATE WRITE FINISHED');
      return true;
    }), error => error instanceof SetupCancelled);
    assert.equal(lateWriteFinished, true, 'transaction rollback must wait for the last SDK effect');
    console.log('CANCELLATION CAUGHT');
  `, 'SIGINT');
  assert.ok(output.indexOf('LATE WRITE FINISHED') < output.indexOf('CANCELLATION CAUGHT'));
  assert.doesNotMatch(output, /✓ Проверка без поддержки abort/);
});
