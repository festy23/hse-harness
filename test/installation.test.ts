import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importInstallation } from '../src/cli/import-installation.js';
import { serviceUnit } from '../src/cli/system-service.js';

async function fixture(
  action: (source: string, destination: string, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hse-import-'));
  const source = join(root, 'old');
  const destination = join(root, 'new');
  try {
    await mkdir(join(source, 'data', 'sessions'), { recursive: true });
    await mkdir(join(source, 'secrets'));
    await writeFile(join(source, 'config.local.json'), '{}');
    await writeFile(
      join(source, '.env'),
      "TELEGRAM_BOT_TOKEN='fixture-only'\nSTUDY_DATA_DIR=data\n",
    );
    await action(source, destination, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('import preserves transcript, queue, credentials and delivery state, rebases session path and excludes PID/test data', async () => {
  await fixture(async (source, destination) => {
    const transcript =
      '{"type":"session","id":"fixture"}\n{"type":"message","message":{"role":"user","content":"Задание"}}\n';
    await writeFile(join(source, 'data', 'sessions', 'fixture.jsonl'), transcript);
    const state = {
      sessionPath: '/old/mac/data/sessions/fixture.jsonl',
      queue: [{ id: 'pending', sources: [{ text: 'Новый срок' }] }],
      delivered: { reminder: 123 },
      bootstrapFinished: true,
    };
    await writeFile(join(source, 'data', 'operations.json'), JSON.stringify(state));
    await writeFile(join(source, 'data', 'service.lock'), 'invalid-stale-lock');
    await mkdir(join(source, 'data', 'e2e'));
    await writeFile(join(source, 'data', 'e2e', 'fixture'), 'not runtime');
    await writeFile(join(source, 'secrets', 'telegram.session'), 'test-auth');
    await importInstallation(source, destination);
    assert.equal(
      await readFile(join(destination, 'data', 'sessions', 'fixture.jsonl'), 'utf8'),
      transcript,
    );
    const restored = JSON.parse(
      await readFile(join(destination, 'data', 'operations.json'), 'utf8'),
    );
    assert.deepEqual(restored, {
      ...state,
      sessionPath: join(destination, 'data', 'sessions', 'fixture.jsonl'),
    });
    assert.equal(
      await readFile(join(destination, 'secrets', 'telegram.session'), 'utf8'),
      'test-auth',
    );
    assert.equal(
      await readFile(join(destination, '.env'), 'utf8'),
      await readFile(join(source, '.env'), 'utf8'),
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(source, 'data', 'operations.json'), 'utf8')),
      state,
    );
    assert.equal(
      (await stat(join(destination, 'secrets', 'telegram.session'))).mode & 0o777,
      0o600,
    );
    for (const name of ['service.lock', 'e2e']) {
      await assert.rejects(stat(join(destination, 'data', name)), { code: 'ENOENT' });
    }
  });
});

test('missing session aborts import without leaving partial state or changing its source', async () => {
  await fixture(async (source, destination, root) => {
    const original = '{"sessionPath":"/missing/session.jsonl","queue":[]}';
    await writeFile(join(source, 'data', 'operations.json'), original);
    await assert.rejects(importInstallation(source, destination), /Pi-сессия/);
    assert.equal(await readFile(join(source, 'data', 'operations.json'), 'utf8'), original);
    assert.deepEqual(await readdir(root), ['old']);
  });
});

test('import refuses a live source, nested destination, existing owner, and symlinked secrets', async () => {
  await fixture(async (source, destination) => {
    await writeFile(join(source, 'data', 'service.lock'), String(process.pid));
    await assert.rejects(importInstallation(source, destination), /останови старого бота/);
    await rm(join(source, 'data', 'service.lock'));
    await assert.rejects(
      importInstallation(source, join(source, 'nested')),
      /вне старой установки/,
    );
    await mkdir(destination);
    await writeFile(join(destination, 'owner'), 'keep');
    await assert.rejects(importInstallation(source, destination), /уже существует/);
    assert.equal(await readFile(join(destination, 'owner'), 'utf8'), 'keep');
    await rm(destination, { recursive: true });
    if (process.platform !== 'win32') {
      await symlink(join(source, '.env'), join(source, 'secrets', 'linked'));
      await assert.rejects(importInstallation(source, destination), /символические ссылки/);
      await assert.rejects(stat(destination), { code: 'ENOENT' });
    }
  });
});

test('systemd unit uses the stable launcher and explicit persistent paths with no credential values', () => {
  const home = '/home/study/a space%$';
  const unit = serviceUnit({
    node: '/usr/bin/node',
    executable: home + '/runtime/launcher.mjs',
    home,
    uid: 1000,
    gid: 1000,
    paths: {
      DOTENV_CONFIG_PATH: home + '/.env',
      STUDY_DATA_DIR: home + '/data',
      STUDY_CONFIG: home + '/config.local.json',
      STUDY_SECRETS_DIR: home + '/secrets',
    },
  });
  assert.match(unit, /User=1000\nGroup=1000/);
  assert.ok(unit.includes('WorkingDirectory=/home/study/a space%%$\n'));
  assert.ok(
    unit.includes('ExecStart="/usr/bin/node" "/home/study/a space%%$$/runtime/launcher.mjs"\n'),
  );
  assert.ok(unit.includes('Environment="HSE_HARNESS_HOME=/home/study/a space%%$"'));
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /KillMode=control-group/);
  assert.doesNotMatch(unit, /TOKEN|PASSWORD|npm run build/);
  assert.throws(
    () => serviceUnit({ node: 'node', executable: 'cli', home, uid: 0, gid: 0, paths: {} }),
    /непривилегированного/,
  );
  assert.throws(
    () =>
      serviceUnit({
        node: 'node',
        executable: 'cli',
        home: '/path\ninjected',
        uid: 1000,
        gid: 1000,
        paths: {},
      }),
    /неподдерживаемый/,
  );
});
