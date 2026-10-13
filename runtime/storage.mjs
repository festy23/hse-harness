import { open, readFile, mkdir, rename, unlink, lstat, readdir, chmod } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('runtime directory is not a real directory');
  if (process.getuid && info.uid !== process.getuid()) throw new Error('runtime directory belongs to another user');
  if ((info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

export async function safePath(root, path, { allowMissing = false } = {}) {
  root = resolve(root); path = resolve(path);
  const rel = relative(root, path);
  if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new Error('runtime path escapes its root');
  const parts = [root, ...rel.split(sep).filter(Boolean)];
  let current = parts.shift();
  for (const component of [null, ...parts]) {
    if (component !== null) current = resolve(current, component);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return path;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error('runtime path contains a symbolic link');
    if (process.getuid && info.uid !== process.getuid()) throw new Error('runtime path belongs to another user');
  }
  return path;
}

export async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicJSON(path, value) {
  await privateDirectory(dirname(path));
  await safePath(dirname(path), path, { allowMissing: true });
  const temp = path + '.tmp-' + randomUUID();
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync(); await handle.close(); handle = null;
    await rename(temp, path); await syncDirectory(dirname(path));
  } finally {
    if (handle) await handle.close();
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function readJSON(path, fallback, { maximumBytes = 16 * 1024 * 1024 } = {}) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) throw new Error('invalid runtime JSON file');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT' && arguments.length >= 2) return fallback; throw error; }
}

// Unknown or live PIDs are conflicts, never a reason to kill a process. A nonce prevents
// the previous owner from removing a replacement lock during orderly shutdown.
export async function acquireOwnershipLock(path, identity = {}) {
  await privateDirectory(dirname(path));
  await safePath(dirname(path), path, { allowMissing: true });
  const record = { ...identity, pid: process.pid, ownerId: randomUUID(), createdAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); await handle.close(); handle = null;
      await syncDirectory(dirname(path));
      return { ...record, async release() {
        const current = await readJSON(path, null);
        if (current?.ownerId !== record.ownerId) return false;
        await unlink(path); await syncDirectory(dirname(path)); return true;
      } };
    } catch (error) {
      if (handle) await handle.close();
      if (error.code !== 'EEXIST') throw error;
      // Serialize stale-lock reclamation. A crashed recovery guard requires explicit
      // inspection; refusing progress is preferable to moving a newly acquired lock.
      let recovery;
      const recoveryPath = path + '.recovery';
      try { recovery = await open(recoveryPath, 'wx', 0o600); }
      catch (guard) { if (guard.code === 'EEXIST') throw new Error('ownership lock recovery is already in progress'); throw guard; }
      try {
        const old = await readJSON(path);
        if (!Number.isSafeInteger(old.pid) || old.pid <= 0) throw new Error('invalid ownership lock; manual inspection required');
        try { process.kill(old.pid, 0); throw new Error('runtime ownership lock is held by a live or unverified process'); }
        catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
        const current = await readJSON(path);
        if (current.ownerId !== old.ownerId) throw new Error('ownership lock changed during recovery');
        await rename(path, path + '.stale-' + randomUUID()); await syncDirectory(dirname(path));
      } finally { await recovery.close(); await unlink(recoveryPath); }

    }
  }
  throw new Error('cannot acquire runtime ownership lock');
}
export const ownershipLock = acquireOwnershipLock;

export async function acquireLock(path, identity = {}) {
  const lock = await acquireOwnershipLock(path, identity);
  const release = () => lock.release();
  release.identity = { pid: lock.pid, ownerId: lock.ownerId };
  return release;
}

// Called before publishing COMPLETE. npm's successful close is not itself a
// power-loss durability barrier for the files it has extracted.
export async function syncTree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) await syncTree(path);
    else if (entry.isFile()) {
      const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    }
  }
  await syncDirectory(root);
}
