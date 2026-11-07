import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const build = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
});
const [code] = await once(build, 'exit');
if (code !== 0) {
  process.exit(code ?? 1);
}
const { PiAssistant } = await import('../dist/pi.js');
const { SessionManager } = await import('@earendil-works/pi-coding-agent');
const { ComputeClient } = await import('../dist/compute/index.js');
const { Store } = await import('../dist/store.js');
console.log(
  JSON.stringify({
    host: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      memoryGiB: +(totalmem() / 2 ** 30).toFixed(1),
    },
    note: 'Synthetic local fixtures; native Pi synchronous persistence and individual JSON snapshots remain on the main thread.',
  }),
);
async function measure(name, run) {
  let ticks = 0,
    maxGap = 0,
    last = performance.now();
  const gaps = [];
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    gaps.push(now - last);
    last = now;
    ticks++;
  }, 1);
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
  const start = performance.now();
  const result = await run();
  const elapsed = performance.now() - start;
  await new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
  clearInterval(timer);
  console.log(
    JSON.stringify({
      name,
      elapsedMs: +elapsed.toFixed(2),
      maxTimerGapMs: +maxGap.toFixed(2),
      p95TimerGapMs: +(
        gaps.sort((a, b) => a - b)[Math.max(0, Math.ceil(gaps.length * 0.95) - 1)] ?? 0
      ).toFixed(2),
      timerTicks: ticks,
      ...result,
    }),
  );
}
const pi = new PiAssistant();
pi.manager = SessionManager.inMemory();
for (let i = 0; i < 10000; i++) {
  pi.manager.appendCustomEntry('benchmark', { i, text: 'учебный источник '.repeat(128) });
}
await measure('Pi search 10000 original entries, absent query', async () => ({
  matches: (await pi.search('нет совпадения')).length,
}));
class MemoryStore extends Store {
  snapshots = 0;
  async persistSnapshot() {
    this.snapshots++;
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}
const state = new MemoryStore('/unused');
for (let i = 0; i < 12800; i++) {
  state.state.outbox[String(i)] = {
    text: 'x'.repeat(4096),
    chunks: [{ state: 'sent' }],
    created: 1,
  };
}
await measure('50MiB state, 100 concurrent save barriers', async () => {
  await Promise.all(Array.from({ length: 100 }, () => state.save()));
  await state.flush();
  return { writes: state.snapshots, requestedSaves: 100 };
});
const client = new ComputeClient();
try {
  const snippet = '<p>Учебный текст и срок сдачи.</p><a href="https://hse.ru/course">Курс</a>';
  const html =
    '<html><body>' +
    snippet.repeat(Math.floor(999000 / Buffer.byteLength(snippet))) +
    '</body></html>';
  await measure('HTML nearly 1MB, real compiled worker', async () => ({
    inputBytes: Buffer.byteLength(html),
    outputCharacters: (
      await client.run({ type: 'html', mode: 'hse', html, baseUrl: 'https://hse.ru/' })
    ).text.length,
  }));
  const data =
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:benchmark\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T093000Z\r\nRRULE:FREQ=HOURLY;UNTIL=20261101T000000Z\r\nSUMMARY:Benchmark\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  await measure('20 hourly recurrences over 31 days, worker', async () => {
    let count = 0;
    for (let i = 0; i < 20; i++) {
      count += (
        await client.run({
          type: 'calendar',
          action: 'range',
          data,
          url: 'https://fixture.test/' + i + '.ics',
          from: '2026-10-01T00:00:00Z',
          to: '2026-11-01T00:00:00Z',
        })
      ).length;
    }
    return { occurrences: count };
  });
} finally {
  await client.close();
}
