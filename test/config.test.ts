import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { calendarSettings, legacyProfile, loadConfig, parseConfig } from '../src/config.js';

test('config keeps optional defaults and clamps finite polling intervals to 15 seconds', () => {
  const defaults = parseConfig({ ownerId: 1, chats: [] });
  assert.deepEqual(defaults, {
    ...calendarSettings({}),
    ownerId: 1,
    chats: [],
    model: '',
    folders: [],
    pollSeconds: 60,
    profile: undefined,
  });
  for (const pollSeconds of [-100, 0, 14.9, 15, 60, 90.5, 2147483.647]) {
    const config = parseConfig({ ownerId: 1, chats: [], pollSeconds });
    assert.equal(config.pollSeconds, Math.max(15, pollSeconds));
    assert.ok(config.pollSeconds * 1000 <= 2147483647);
  }
});

test('config validates non-JSON input without numeric coercion', () => {
  for (const pollSeconds of [NaN, Infinity, -Infinity, {}, [], '15', true, null]) {
    assert.throws(() => parseConfig({ ownerId: 1, chats: [], pollSeconds }), /pollSeconds/);
  }
  for (const value of [null, [], 'config', 1]) {
    assert.throws(() => parseConfig(value));
  }
});

test('config preserves validated integration settings and a complete study profile', () => {
  const input = {
    ownerId: 123,
    chats: [{ id: '-100123', title: 'Study', allowQuestions: false }],
    folders: ['INBOX', 'Учёба'],
    model: 'provider/model',
    pollSeconds: 90,
    profile: legacyProfile,
    features: { googleCalendar: true, icloudCalendar: false },
    calendars: {
      timetable: { provider: 'google', id: 'schedule', label: 'Расписание' },
      agent: { provider: 'google', id: 'deadlines' },
    },
  };
  assert.deepEqual(parseConfig(input), input);
});

test('loadConfig rejects malformed settings before starting integrations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hse-config-'));
  const path = join(directory, 'config.json');
  const previous = process.env.STUDY_CONFIG;
  process.env.STUDY_CONFIG = path;
  const cases: [string, unknown][] = [
    ['folders', 'INBOX'],
    ['folders', null],
    ['folders', [1]],
    ['pollSeconds', 'bad'],
    ['pollSeconds', '60'],
    ['pollSeconds', null],
    ['pollSeconds', true],
    ['pollSeconds', 2147483.648],
    ['model', 123],
    ['model', null],
    ['profile', null],
    ['profile', {}],
    ['profile', { ...legacyProfile, name: 1 }],
    ['profile', { ...legacyProfile, course: '3' }],
    ['profile', { ...legacyProfile, course: 0 }],
    ['profile', { ...legacyProfile, course: 7 }],
    ['profile', { ...legacyProfile, course: 2.5 }],
    ['chats', [{ id: '-100123', title: 'Study', allowQuestions: 'yes' }]],
    ['chats', [{ id: 'not-numeric', title: 'Study' }]],
    ['chats', [null]],
    ['ownerId', '123'],
    ['ownerId', 0],
  ];
  try {
    for (const [field, value] of cases) {
      await t.test(`${field} rejects ${JSON.stringify(value)}`, async () => {
        await writeFile(path, JSON.stringify({ ownerId: 1, chats: [], [field]: value }));
        await assert.rejects(loadConfig());
      });
    }
    await t.test('JSON exponent overflow cannot reach timers', async () => {
      await writeFile(path, '{"ownerId":1,"chats":[],"pollSeconds":1e400}');
      await assert.rejects(loadConfig());
    });
  } finally {
    if (previous === undefined) {
      delete process.env.STUDY_CONFIG;
    } else {
      process.env.STUDY_CONFIG = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
