import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert } from 'html-to-text';
import { ComputeClient } from '../src/compute/index.js';
import { createOperation, OperationError } from '../src/operations.js';

const workerUrl = new URL('../dist/compute/worker.js', import.meta.url);
const htmlJob = {
  type: 'html' as const,
  mode: 'hse' as const,
  html: '<html><body><p>Исходный текст</p><a href="/course">Курс</a><a href="https://elsewhere.test/">Внешний</a></body></html>',
  baseUrl: 'https://hse.ru/catalog',
};
test('compiled pure worker preserves HSE extraction and mail conversion settings', async () => {
  const client = new ComputeClient({ workerUrl });
  try {
    const hse = await client.run<{ text: string; links: string[] }>(htmlJob);
    assert.equal(
      hse.text,
      convert(htmlJob.html, { wordwrap: false, baseElements: { selectors: ['body'] } }),
    );
    assert.deepEqual(hse.links, ['https://hse.ru/course']);
    const html =
      '<p>Письмо</p><img src="fixture" alt="пропустить"><a href="https://hse.ru">Ссылка</a>';
    const mail = await client.run<{ text: string; links: string[] }>({
      type: 'html',
      mode: 'mail',
      html,
    });
    assert.equal(
      mail.text,
      convert(html, {
        wordwrap: false,
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: 'a', options: { ignoreHref: false } },
        ],
      }),
    );
    assert.deepEqual(mail.links, []);
    await assert.rejects(
      client.run({ ...htmlJob, html: 'a'.repeat(1_000_001) }),
      (e: unknown) => e instanceof OperationError && e.kind === 'payload-limit',
    );
  } finally {
    await client.close();
  }
});

test('CPU admission is bounded and abort settles termination before another pure job can run', async () => {
  const client = new ComputeClient({ workerUrl, maxQueued: 1 });
  const parent = createOperation('tool', 5000);
  try {
    const cancelled = assert.rejects(
      client.run({ ...htmlJob, html: '<p>текст</p>'.repeat(30000) }, parent),
      (e: unknown) => e instanceof OperationError && e.kind === 'cancelled',
    );
    const next = client.run<{ text: string }>(htmlJob);
    await assert.rejects(
      client.run(htmlJob),
      (e: unknown) => e instanceof OperationError && e.kind === 'rate-limit',
    );
    parent.abort();
    await cancelled;
    assert.match((await next).text, /Исходный текст/);
    assert.match((await client.run<{ text: string }>(htmlJob)).text, /Исходный текст/);
  } finally {
    parent.dispose();
    await client.close();
  }
});

test('CPU deadline kills only the pure worker and subsequent jobs can use a fresh worker', async () => {
  const client = new ComputeClient({ workerUrl });
  const short = createOperation('tool', 1);
  try {
    await assert.rejects(
      client.run(htmlJob, short),
      (e: unknown) => e instanceof OperationError && e.kind === 'deadline',
    );
    const result = await client.run<{ text: string }>(htmlJob);
    assert.match(result.text, /Исходный текст/);
  } finally {
    short.dispose();
    await client.close();
  }
});

test('CPU work leaves parent timers runnable during recurrence expansion', async () => {
  const client = new ComputeClient({ workerUrl });
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 1);
  const data =
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:fixture\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T093000Z\r\nRRULE:FREQ=HOURLY;UNTIL=20261101T000000Z\r\nSUMMARY:Fixture\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  try {
    const result = await client.run<unknown[]>({
      type: 'calendar',
      action: 'range',
      data,
      url: 'https://fixture.test/event.ics',
      from: '2026-10-01T00:00:00Z',
      to: '2026-11-01T00:00:00Z',
    });
    assert.ok(result.length > 700);
    assert.ok(ticks > 1, 'parent timer must run while compiled worker transforms calendar');
  } finally {
    clearInterval(timer);
    await client.close();
  }
});
