import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { ReleaseStore, runInstaller } from './releases.mjs';
import { findNpm } from './executable.mjs';
import { readJSON, acquireLock, atomicJSON } from './storage.mjs';
import { stableVersion, PACKAGE_NAME } from './manifest.mjs';
import { compatible, compareVersions } from './supervisor.mjs';
import { requestUpdate } from './installation.mjs';

export async function grantTelegramUpdate(home, id) {
  const root = join(resolve(home), 'runtime'),
    release = await acquireLock(join(root, 'settings.lock'));
  try {
    const settings = await readJSON(join(root, 'settings.json'), { enabled: true });
    if (settings.enabled === false) {
      settings.enabled = true;
      settings.telegramUpdatePermission = id;
      await atomicJSON(join(root, 'settings.json'), settings);
    }
  } finally {
    await release();
  }
}
export async function restoreTelegramUpdatePermission(home, id) {
  const root = join(resolve(home), 'runtime'),
    release = await acquireLock(join(root, 'settings.lock'));
  try {
    const settings = await readJSON(join(root, 'settings.json'), { enabled: true });
    if (settings.telegramUpdatePermission === id) {
      settings.enabled = false;
      delete settings.telegramUpdatePermission;
      await atomicJSON(join(root, 'settings.json'), settings);
    }
  } finally {
    await release();
  }
}

export async function installApprovedPackage({ home, version, integrity, signal }) {
  if (!stableVersion(version) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) {
    throw Error('Invalid update identity');
  }
  const root = resolve(home),
    journal = await readJSON(join(root, 'runtime/state.json'));
  const manifestPath = resolve(journal.installation.manifestPath);
  const suffix = join('lib', 'node_modules', PACKAGE_NAME, 'package.json');
  if (!manifestPath.endsWith('/' + suffix)) {
    throw Error('Telegram updates require a permanent global npm installation');
  }
  const prefix = manifestPath.slice(0, -suffix.length - 1);
  const npm = await findNpm();
  const store = new ReleaseStore(root, { npm, node: process.execPath });
  const target = await store.prepare(version, { signal });
  if (target.integrity !== integrity) {
    throw Error('Update integrity changed');
  }
  if (
    !compatible(journal.active, target) ||
    compareVersions(journal.supervisorVersion, target.manifest.minSupervisorVersion) < 0
  ) {
    throw Error('This release requires a serviced runtime upgrade');
  }
  const current = await readFile(manifestPath, 'utf8')
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === 'ENOENT') {
        return { version: journal.installedVersion ?? journal.active.version };
      }
      throw error;
    });
  if (!stableVersion(current.version) || compareVersions(current.version, version) > 0) {
    throw Error('A newer package is already installed');
  }
  if ((await readJSON(join(root, 'runtime/settings.json'), { enabled: true })).enabled === false) {
    throw Error('Update application was disabled');
  }
  if (current.version === version) {
    if (
      journal.quarantine?.some((q) => q.version === version) ||
      journal.manualHold?.version === version
    ) {
      await requestUpdate(root, { action: 'retry' });
    }
    return;
  }
  const scratch = await mkdtemp(join(root, 'runtime', '.telegram-install-'));
  try {
    const userConfig = join(scratch, 'user.npmrc'),
      globalConfig = join(scratch, 'global.npmrc');
    await writeFile(userConfig, '', { mode: 0o600 });
    await writeFile(globalConfig, '', { mode: 0o600 });

    const env = {
      PATH: [dirname(process.execPath), dirname(npm), '/usr/bin', '/bin'].join(':'),
      HOME: process.env.HOME,
    };
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'NODE_USE_ENV_PROXY',
      'SSL_CERT_FILE',
      'NODE_EXTRA_CA_CERTS',
    ]) {
      if (process.env[key]) {
        env[key] = process.env[key];
      }
    }
    await runInstaller(
      npm,
      [
        'install',
        '--global',
        '--prefix',
        prefix,
        `${PACKAGE_NAME}@${version}`,
        '--omit=dev',
        '--ignore-scripts',
        '--engine-strict',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        '--registry=https://registry.npmjs.org/',
        `--userconfig=${userConfig}`,
        `--globalconfig=${globalConfig}`,
        `--cache=${join(scratch, 'cache')}`,
        '--fetch-retries=0',
        '--fetch-timeout=120000',
      ],
      { cwd: scratch, env, signal, timeout: 300000 },
    );
    if (JSON.parse(await readFile(manifestPath, 'utf8')).version !== version) {
      throw Error('npm did not install the requested version');
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
