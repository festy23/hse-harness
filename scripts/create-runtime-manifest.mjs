import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME, PI_VERSION, ESBUILD_POLICY, fileIdentity, PROTOCOL_VERSION, STATE_SCHEMA_VERSION, SUPERVISOR_VERSION, stableVersion, sha256 } from '../runtime/manifest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
if (metadata.name !== PACKAGE_NAME || !stableVersion(metadata.version)) throw new Error('manifest requires a stable public package version');
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });
if (result.status !== 0) throw new Error('cannot inventory npm package');
const parsed = JSON.parse(result.stdout);
const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
const files = pack.files.filter(file => /^(dist\/|runtime\/|bin\/|node_modules\/|scripts\/process\.mjs$|package\.json$)/.test(file.path));
const inventory = [];
for (let start = 0; start < files.length; start += 24) {
  inventory.push(...await Promise.all(files.slice(start, start + 24).map(async file => {
    const identity = await fileIdentity(root, file.path);
    // npm tar normalizes modes; pack supplies the exact archived mode.
    if (identity.type === 'file') identity.mode = file.mode;
    return identity;
  })));
}

const dependencies = [];
const locations = new Set(files.filter(file => file.path.endsWith('/package.json')).map(file => file.path.slice(0, -'/package.json'.length)));
for (const location of [...locations].sort()) {
  if (!lock.packages[location]) continue;
  const actual = JSON.parse(await readFile(join(root, location, 'package.json'), 'utf8'));
  if (actual.version !== lock.packages[location].version) throw new Error('bundled dependency drift: ' + location);
  dependencies.push({ path: location, name: actual.name, version: actual.version });
}
for (const name of metadata.bundleDependencies) {
  if (!dependencies.some(entry => entry.path === 'node_modules/' + name)) throw new Error('unbundled runtime dependency: ' + name);
}
const esbuild = JSON.parse(await readFile(join(root, 'node_modules/esbuild/package.json'), 'utf8'));
if (esbuild.version !== ESBUILD_POLICY.version || sha256(await readFile(join(root, 'node_modules/esbuild/install.js'))) !== ESBUILD_POLICY.scriptSha256) throw new Error('esbuild bootstrap needs explicit audit before release');
const manifest = {
  format: 1, packageName: PACKAGE_NAME, version: metadata.version,
  protocolVersion: PROTOCOL_VERSION, minSupervisorVersion: SUPERVISOR_VERSION,
  stateSchemaVersion: STATE_SCHEMA_VERSION, readableStateVersions: [1, 2], writableStateVersion: 2,
  formats: { operations: 2, approvals: 1, calendar: 1, auth: 1, pi: PI_VERSION },
  piVersion: PI_VERSION, engines: metadata.engines,
  platforms: Object.keys(ESBUILD_POLICY.platforms), esbuild: ESBUILD_POLICY,
  dependencies, inventory,
};
await writeFile(join(root, 'runtime-manifest.json'), JSON.stringify(manifest) + '\n', { mode: 0o644 });
console.log(`Runtime manifest: ${inventory.length} files, ${dependencies.length} fixed dependencies, protocol ${PROTOCOL_VERSION}.`);
