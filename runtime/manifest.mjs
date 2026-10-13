import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative, dirname, sep, isAbsolute } from 'node:path';

export const PACKAGE_NAME = '@ivan-boss/hse-harness';
export const PROTOCOL_VERSION = 1;
export const STATE_SCHEMA_VERSION = 2;
export const PI_VERSION = '1.0.2';
export const SUPERVISOR_VERSION = '1.0.0';
export const ESBUILD_POLICY = Object.freeze({
  version: '0.28.2',
  scriptSha256: '612294e278914443bdcf81cb17f54afec34dbdd2ebd999a6ee187912320cc315',
  platforms: {
    'darwin-arm64': '10b6243df618d374bb2d5c9cfbe7052e1405f6aa4e53a6164f11a91b9f2e1384',
    'darwin-x64': '7fe5c9c905fff0a05d92db98929434ab4d3b6dd92d7a7688922db74380c75df3',
    'linux-x64': 'e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100',
    'linux-arm64': '90bd269553d258e80b19e3ccab4f98f0831f87442a2f056510ce24fd1b425fc2',
  },
});
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);

export function validateRelativePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || isAbsolute(path) || path.split('/').some(p => !p || p === '..' || p === '.') || path.includes('\0')) throw new Error('invalid inventory path');
  return path;
}

export async function fileIdentity(root, path) {
  validateRelativePath(path);
  const target = join(root, path);
  let parent = root;
  for (const component of path.split('/').slice(0,-1)) { parent = join(parent, component); if ((await lstat(parent)).isSymbolicLink()) throw new Error('inventory parent is a symbolic link'); }
  const info = await lstat(target);
  if (info.isSymbolicLink()) {
    // Only bounded, package-internal bin links are allowed. Inventory records the link itself.
    const { readlink, realpath } = await import('node:fs/promises');
    const link = await readlink(target); const resolved = await realpath(target); const canonicalRoot = await realpath(root);
    if (isAbsolute(link) || !(resolved === canonicalRoot || resolved.startsWith(canonicalRoot + sep))) throw new Error('inventory symlink escapes installation');
    return { path, type: 'symlink', target: link };
  }
  if (!info.isFile()) throw new Error('inventory entry is not a file');
  return { path, type: 'file', sha256: sha256(await readFile(target)), size: info.size, mode: info.mode & 0o777 };
}

export async function inventoryTree(root, prefix = '') {
  const entries = []; const files = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) entries.push(...await inventoryTree(root, path));
    else files.push(path);
  }
  // Bound open files and memory while keeping metadata-heavy bundled trees fast.
  for (let start = 0; start < files.length; start += 24) entries.push(...await Promise.all(files.slice(start, start + 24).map(path => fileIdentity(root, path))));
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function treePaths(root, prefix = '') {
  const paths = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) paths.push(...await treePaths(root, path)); else paths.push(path);
  }
  return paths;
}

export async function verifyInventory(root, inventory, { exact = false } = {}) {
  if (!Array.isArray(inventory) || !inventory.length) throw new Error('missing runtime inventory');
  const seen = new Set();
  for (const expected of inventory) {
    validateRelativePath(expected.path);
    if (seen.has(expected.path)) throw new Error('duplicate inventory path'); seen.add(expected.path);
  }
  for (let start = 0; start < inventory.length; start += 24) await Promise.all(inventory.slice(start, start + 24).map(async expected => {
    const actual = await fileIdentity(root, expected.path);
    if (actual.type !== expected.type || actual.sha256 !== expected.sha256 || actual.size !== expected.size || actual.target !== expected.target || actual.mode !== expected.mode) throw new Error('runtime inventory mismatch: ' + expected.path);
  }));
  if (exact) {
    const actual = await treePaths(root);
    if (actual.length !== inventory.length) throw new Error('runtime contains unrecorded files');
    for (const path of actual) if (!seen.has(path)) throw new Error('runtime contains unrecorded file: ' + path);
  }
}

export function assertManifest(manifest, version, { platform = process.platform, arch = process.arch, nodeVersion = process.versions.node } = {}) {
  if (!manifest || manifest.format !== 1 || manifest.packageName !== PACKAGE_NAME || manifest.version !== version || !stableVersion(version)) throw new Error('invalid release manifest identity');
  if (manifest.protocolVersion !== PROTOCOL_VERSION || manifest.minSupervisorVersion !== SUPERVISOR_VERSION || manifest.stateSchemaVersion !== STATE_SCHEMA_VERSION || manifest.piVersion !== PI_VERSION) throw new Error('incompatible release protocol or state schema');
  const expectedFormats = { operations: 2, approvals: 1, calendar: 1, auth: 1, pi: PI_VERSION };
  if (manifest.writableStateVersion !== 2 || !manifest.readableStateVersions?.includes(1) || !manifest.readableStateVersions?.includes(2)) throw new Error('incompatible state read/write policy');
  if (!manifest.formats || Object.entries(expectedFormats).some(([key, value]) => manifest.formats[key] !== value)) throw new Error('incompatible persisted data formats');
  const current = nodeVersion.split('.').map(Number);
  if (current[0] < 22 || current[0] === 22 && current[1] < 19 || manifest.engines?.node !== '>=22.19.0') throw new Error('incompatible Node engine');
  if (!manifest.platforms?.includes(platform + '-' + arch) || !ESBUILD_POLICY.platforms[platform + '-' + arch]) throw new Error('unsupported runtime platform');
  if (manifest.esbuild?.version !== ESBUILD_POLICY.version || manifest.esbuild.scriptSha256 !== ESBUILD_POLICY.scriptSha256 || manifest.esbuild.platforms?.[platform + '-' + arch] !== ESBUILD_POLICY.platforms[platform + '-' + arch]) throw new Error('unaudited esbuild bootstrap policy');
  if (!Array.isArray(manifest.dependencies) || !Array.isArray(manifest.inventory)) throw new Error('missing runtime dependency inventory');
  for (const dependency of manifest.dependencies) { validateRelativePath(dependency.path); if (!dependency.path.startsWith('node_modules/') || typeof dependency.name !== 'string' || typeof dependency.version !== 'string') throw new Error('invalid bundled dependency inventory'); }
  return manifest;
}
