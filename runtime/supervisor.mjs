import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ReleaseStore } from './releases.mjs';
import { atomicJSON, readJSON, acquireLock } from './storage.mjs';

export const SUPERVISOR_VERSION = '1.0.0';
export const PROTOCOL_VERSION = 1;
const packageName = '@ivan-boss/hse-harness';
const stable = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export function compareVersions(a, b) {
  if (!stable(a) || !stable(b)) throw new Error('Нужна стабильная semver-версия');
  const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
const identity = value => value && `${value.version}:${value.integrity}`;
const detail = error => String(error?.message ?? error).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 500);
const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

export function compatible(from, to) {
  for (const release of [from, to]) {
    const m = release?.manifest;
    if (!m || m.protocolVersion !== PROTOCOL_VERSION || !stable(release.version)) return false;
    const minimum = m.minimumSupervisorVersion ?? m.minSupervisorVersion ?? '1.0.0';
    if (!stable(minimum) || compareVersions(minimum, SUPERVISOR_VERSION) > 0) return false;
  }
  const a = from.manifest, b = to.manifest;
  return a.stateSchemaVersion === b.stateSchemaVersion && a.piVersion === b.piVersion &&
    JSON.stringify(a.formats) === JSON.stringify(b.formats) &&
    a.writableStateVersion === b.writableStateVersion;
}

/** The only owner of process switching. Release installation never touches the live worker. */
export class Supervisor {
  constructor(home, options = {}) {
    this.home = resolve(home);
    this.root = join(this.home, 'runtime');
    this.options = options;
    this.node = options.node ?? process.execPath;
    this.releaseStore = options.releaseStore;
    this.pollMs = options.pollMs ?? 10_000;
    this.drainMs = options.drainMs ?? 120_000;
    this.bootMs = options.bootMs ?? 30_000;
    this.finishMs = options.finishMs ?? 30_000;
    this.probationMs = options.probationMs ?? 120_000;
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.clock = options.clock ?? (() => performance.now());
    this.waiters = new Set();
    this.stopController = new AbortController();
    this.lastHeartbeat = 0;
    this.sequence = 0;
    this.observations = 0;
    this.stopping = false;
    this.blocked = false;
    this.retryAt = 0;
    this.retryCount = 0;
    this.notices = [];
    this.saves = Promise.resolve();
  }

  async save() {
    this.state.supervisorVersion = SUPERVISOR_VERSION;
    this.state.supervisorPid = this.stopping && (!this.worker || this.worker.exited) ? null : process.pid;
    this.state.runningVersion = this.worker && !this.worker.exited ? this.worker.release.version : null;
    this.state.workerId = this.worker && !this.worker.exited ? this.worker.id : null;
    this.state.updatedAt = new Date().toISOString();
    this.state.nextRetryAt = this.retryAt;
    this.state.preparationRetryCount = this.retryCount;
    const snapshot = structuredClone(this.state);
    this.saves = this.saves.then(() => atomicJSON(join(this.root, 'state.json'), snapshot));
    await this.saves;
  }

  async settings() {
    return readJSON(join(this.root, 'settings.json'), { enabled: true });
  }

  async installed() {
    try {
      const value = JSON.parse(await readFile(this.state.installation.manifestPath, 'utf8'));
      return value.name === packageName && stable(value.version) ? value.version : undefined;
    } catch (e) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes(e.code) || e instanceof SyntaxError) return;
      throw e;
    }
  }

  async notice(text, id) {
    const key = id ?? randomUUID();
    this.state.notices ??= [];
    if (this.state.notices.some(n => n.id === key)) return;
    this.state.notices.push({ id: key, text });
    // The worker records notice identity before acknowledgement. Supervisor is never a second sender.
    if (this.state.notices.length > 50) this.state.notices.splice(0, this.state.notices.length - 50);
    await this.save();
  }

  deliverNotices() {
    if (!this.worker || this.worker.exited || this.worker.mode !== 'active') return;
    for (const notice of this.state.notices ?? []) this.send('notice', notice);
  }

  send(type, extra = {}) {
    if (!this.worker || this.worker.exited || !this.worker.child.connected) return;
    const envelope = { protocolVersion: PROTOCOL_VERSION, attemptId: this.worker.attemptId,
      workerId: this.worker.id, sequence: ++this.sequence, type, ...extra };
    this.worker.child.send(envelope, error => {
      if (error && !this.worker?.exited) this.options.log?.('IPC disconnected');
    });
    return envelope;
  }

  async command(type, response, timeout, extra = {}) {
    if (!this.worker || this.worker.exited) throw new Error('Worker не работает');
    const worker = this.worker;
    const sequence = this.sequence + 1;
    return new Promise((resolve, reject) => {
      const waiter = { worker, sequence, response, resolve: value => { cleanup(); resolve(value); },
        reject: error => { cleanup(); reject(error); } };
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(waiter); };
      const timer = setTimeout(() => waiter.reject(new Error(`Timeout ${type}`)), timeout);
      this.waiters.add(waiter);
      if (!this.send(type, extra)) waiter.reject(new Error('Worker IPC закрыт'));
    });
  }

  async startWorker(release, attemptId, shouldActivate) {
    await this.releaseStore.validate(release);
    if (this.stopping) throw Object.assign(new Error('Запуск отменён остановкой supervisor'), { code: 'STOP_CANCELLED' });
    const worker = { id: randomUUID(), attemptId, release, exited: false, mode: 'preparing' };
    const env = { ...process.env, ...this.options.workerEnv, HSE_HARNESS_HOME: this.home,
      HSE_WORKER_ID: worker.id, HSE_SUPERVISOR: '1', HSE_RELEASE_VERSION: release.version,
      HSE_RELEASE_INTEGRITY: release.integrity };
    const entry = join(release.packageRoot, 'dist', 'main.js');
    worker.child = (this.options.spawn ?? spawn)(this.node, [entry], {
      cwd: this.home, env, stdio: ['ignore', this.options.stdio ?? 'inherit', this.options.stdio ?? 'inherit', 'ipc'],
    });
    this.worker = worker;
    this.lastHeartbeat = this.clock();
    worker.exit = new Promise(resolveExit => {
      worker.child.once('exit', (code, signal) => {
        worker.exited = true;
        worker.code = code; worker.signal = signal;
        for (const waiter of this.waiters) if (waiter.worker === worker) waiter.reject(new Error(`Worker exit ${code ?? signal}`));
        resolveExit();
      });
      worker.child.once('error', error => {
        worker.exited = true;
        for (const waiter of this.waiters) if (waiter.worker === worker) waiter.reject(error);
        resolveExit();
      });
    });
    worker.child.on('message', value => {
      if (this.worker !== worker || !value || value.workerId !== worker.id ||
          value.protocolVersion !== PROTOCOL_VERSION || JSON.stringify(value).length > 65536) return;
      if (value.type === 'health') {
        this.lastHeartbeat = this.clock();
        if (typeof value.health?.nextReminder === 'number') worker.nextReminder = value.health.nextReminder;
        return;
      }
      if (value.attemptId !== worker.attemptId) return;
      if (value.type === 'fatal') {
        worker.fatal = new Error(detail(value.detail ?? value.code));
      }
      if (value.type === 'notice-sent') {
        this.state.notices = (this.state.notices ?? []).filter(n => n.id !== value.id);
        void this.save().catch(error => { this.blocked = true; this.options.log?.(detail(error)); });
        return;
      }
      for (const waiter of this.waiters) {
        if (waiter.worker !== worker || waiter.sequence !== value.sequence) continue;
        if (value.type === waiter.response) waiter.resolve(value);
        else if (['boot-failed', 'fatal'].includes(value.type)) waiter.reject(new Error(detail(value.detail ?? value.code)));
      }
    });
    await this.command('prepare', 'boot-ready', this.bootMs);
    if (this.stopping || shouldActivate && !await shouldActivate()) {
      throw Object.assign(new Error('Автоматическое применение отключено во время переключения'), { code: 'UPDATE_CANCELLED' });
    }
    await this.command('activate', 'active', this.bootMs);
    worker.mode = 'active';
    this.lastHeartbeat = this.clock();
    this.activatedAt = this.clock();
    await this.save();
    return worker;
  }

  async waitExit(worker, timeout) {
    if (worker.exited) return true;
    let timer;
    try { return await Promise.race([worker.exit.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeout); })]); }
    finally { clearTimeout(timer); }
  }

  async stopInactive() {
    const worker = this.worker;
    if (!worker || worker.exited) return;
    // No activation was acknowledged: still request normal shutdown first. Never assume active work is safe to kill.
    worker.child.kill('SIGTERM');
    if (!await this.waitExit(worker, this.finishMs)) {
      this.blocked = true;
      throw new Error('Не подтверждён выход кандидата; второй worker запрещён');
    }
  }

  async drain() {
    const worker = this.worker;
    if (!worker || worker.exited) return true;
    try {
      await this.command('drain', 'quiescent', this.drainMs);
      worker.mode = 'quiescent';
      return true;
    } catch (error) {
      if (worker.exited) return true;
      try { await this.command('resume', 'active', this.bootMs); worker.mode = 'active'; }
      catch { this.blocked = true; throw new Error('Не удалось подтвердить отмену drain'); }
      this.state.deferredReason = 'Текущая операция ещё выполняется; обновление отложено';
      this.retryAt = Date.now() + (this.options.deferMs ?? 600_000);
      await this.notice(this.state.deferredReason, `defer:${this.state.attempt?.id}`);
      return false;
    }
  }

  async finishWorker() {
    const worker = this.worker;
    if (!worker || worker.exited) return;
    this.send('finish');
    worker.mode = 'exiting';
    if (!await this.waitExit(worker, this.finishMs)) {
      this.blocked = true;
      throw new Error('Старый worker завершает работу; новый не запущен');
    }
  }

  async switchTo(target, manual = false) {
    const from = this.state.active;
    if (!compatible(from, target)) throw new Error('Несовместимый формат данных, Pi или supervisor');
    const operations = await readJSON(join(resolve(process.env.STUDY_DATA_DIR ?? join(this.home, 'data')), 'operations.json'), null,
      { maximumBytes: 128 * 1024 * 1024 });
    const schema = operations?.schemaVersion ?? 1;
    if (operations && (!from.manifest.readableStateVersions?.includes(schema) || !target.manifest.readableStateVersions?.includes(schema)))
      throw new Error('Текущий формат учебного состояния несовместим с выбранным выпуском');
    this.state.attempt = { id: randomUUID(), from, to: target, phase: 'draining', startedAt: new Date().toISOString(),
      candidateStartCount: 0, candidateFatalCount: 0, rollbackStartCount: 0, manual };
    await this.save();
    if (this.worker) this.worker.attemptId = this.state.attempt.id;
    if (!await this.drain()) { this.state.attempt.phase = 'deferred'; await this.save(); return false; }
    if (this.stopping) return false;
    const enabled = (await this.settings()).enabled;
    if (!manual && (!enabled || await this.installed() !== target.version)) {
      await this.command('resume', 'active', this.bootMs);
      this.worker.mode = 'active'; this.state.attempt = null; await this.save(); return false;
    }
    this.state.attempt.phase = 'old-exiting'; await this.save();
    await this.finishWorker();
    if (this.stopping) return false;
    this.state.attempt.phase = 'starting'; this.state.attempt.candidateStartCount++; await this.save();
    try {
      if (!manual && !(await this.settings()).enabled) {
        await this.rollback(new Error('Автоматическое применение выключено; восстановлена прежняя версия'), { quarantine: false });
        return false;
      }
      await this.startWorker(target, this.state.attempt.id, () => manual ? true : this.settings().then(s => s.enabled !== false));
      this.state.attempt.activationObserved = true;
      this.state.attempt.phase = 'probation';
      this.state.deferredReason = null;
      if (manual) this.state.manualHold = { ...from, reason: 'manual-rollback', createdAt: new Date().toISOString() };
      await this.save();
      return true;
    } catch (error) {
      if (!this.stopping) await this.rollback(error, { quarantine: error.code !== 'UPDATE_CANCELLED' });
      return false;
    }
  }

  async rollback(error, { quarantine = true } = {}) {
    const attempt = this.state.attempt;
    if (!attempt) throw error;
    attempt.failure = detail(error); attempt.phase = 'rolling-back'; attempt.quarantineOnRollback = quarantine;
    this.state.quarantine ??= [];
    if (quarantine && !this.state.quarantine.some(q => identity(q) === identity(attempt.to)))
      this.state.quarantine.push({ version: attempt.to.version, integrity: attempt.to.integrity, reason: attempt.failure, createdAt: new Date().toISOString() });
    await this.save();
    if (this.worker && !this.worker.exited) {
      if (this.worker.mode === 'active' && !await this.drain()) return;
      if (this.worker.mode === 'quiescent') await this.finishWorker();
      else if (!this.worker.exited) await this.stopInactive();
    }
    if (this.stopping) return;
    await this.releaseStore.validate(attempt.from);
    while (attempt.rollbackStartCount < 3 && !this.stopping) {
      attempt.rollbackStartCount++;
      await this.save();
      try {
        await this.startWorker(attempt.from, attempt.id);
        this.state.active = attempt.from;
        this.state.phase = 'rolled-back';
        this.state.activeCrashCount = Math.max(0, attempt.rollbackStartCount - 1);
        this.state.deferredReason = `Откат: ${attempt.failure}`;
        this.state.attempt = null;
        await this.notice(`Обновление ${attempt.to.version} не запущено. Вернулась версия ${attempt.from.version}: ${attempt.failure}`, `rollback:${attempt.id}`);
        return;
      } catch (e) {
        attempt.failure = detail(e);
        await this.stopInactive();
        await sleep((this.options.retryMs ?? [10_000, 30_000, 60_000])[attempt.rollbackStartCount - 1], this.stopController.signal);
      }
    }
    this.blocked = true; this.state.phase = 'blocked'; await this.save();
  }

  async commit() {
    const attempt = this.state.attempt;
    const settings = await this.settings();
    if (attempt?.phase === 'probation' && !attempt.manual && settings.enabled === false) {
      await this.rollback(new Error('Автоматическое применение выключено во время проверки'), { quarantine: false });
      return;
    }
    if (!attempt || attempt.phase !== 'probation') return;
    this.state.previous = attempt.from;
    this.state.active = attempt.to;
    this.state.lastSuccessfulSwitch = new Date().toISOString();
    this.state.phase = 'committed';
    this.state.pendingVersion = null;
    this.state.activeCrashCount = 0;
    this.state.attempt = null;
    await this.notice(`HSE HARNESS обновлён: ${attempt.from.version} → ${attempt.to.version}. Память и очередь сохранены.`, `commit:${attempt.id}`);
    // Cleanup failures never invalidate a committed live release.
    try { await this.releaseStore.collect([this.state.active, this.state.previous]); }
    catch (error) { this.options.log?.(`GC: ${detail(error)}`); }
  }

  async recover() {
    const attempt = this.state.attempt;
    if (attempt?.phase === 'blocked' || this.state.phase === 'blocked') { this.blocked = true; return; }
    if (attempt?.phase === 'rolling-back' || attempt?.failure) { await this.rollback(new Error(attempt.failure ?? 'Recovery'), { quarantine: attempt.quarantineOnRollback !== false }); return; }
    const candidate = attempt?.activationObserved && ['probation', 'starting'].includes(attempt.phase) ? attempt.to : this.state.active;
    try {
      await this.startWorker(candidate, attempt?.id ?? randomUUID());
      if (candidate === attempt?.to) { attempt.phase = 'probation'; this.activatedAt = this.clock(); }
      else if (!(attempt?.manual && attempt.phase === 'deferred')) this.state.attempt = null;
      await this.save();
    } catch (error) {
      if (this.stopping) return;
      if (attempt) await this.rollback(error);
      else { await this.stopInactive(); this.blocked = true; this.state.phase = 'blocked'; this.state.deferredReason = detail(error); await this.save(); }
    }
  }

  async tick() {
    const settings = await this.settings();
    this.state.updatesEnabled = settings.enabled !== false;
    this.state.installedVersion = await this.installed() ?? null;
    if (this.worker && !this.worker.exited && this.clock() - this.lastHeartbeat > this.heartbeatMs) {
      this.blocked = true; this.state.phase = 'blocked'; this.state.deferredReason = 'Worker не отвечает; второй экземпляр не запущен';
      await this.save();
      // A retry request is processed below, but cannot authorize a second writer.
    }
    if (settings.request && settings.request.id !== this.state.lastRequestId) {
      if (settings.request.action === 'retry') {
        this.state.lastRequestId = settings.request.id;
        if (this.state.manualHold?.version === this.state.installedVersion) this.state.manualHold = null;
        this.state.quarantine = (this.state.quarantine ?? []).filter(q => q.version !== this.state.installedVersion);
        this.blocked = false;
        this.retryAt = 0; this.retryCount = 0;
        this.state.activeCrashCount = 0;
        if (this.state.phase === 'blocked' && (!this.worker || this.worker.exited)) {
          this.state.phase = 'recovering';
          if (this.state.attempt) { this.state.attempt.phase = 'rolling-back'; this.state.attempt.rollbackStartCount = 0; }
          await this.recover();
        } else if (this.worker && !this.worker.exited) {
          if (this.worker.mode === 'active' && this.clock() - this.lastHeartbeat <= this.heartbeatMs) {
            this.state.phase = this.state.attempt?.phase ?? 'idle'; this.state.deferredReason = null;
          } else this.blocked = true;
        }
      } else if (settings.request.action === 'rollback' && this.state.previous && !this.state.attempt) {
        this.state.lastRequestId = settings.request.id;
        await this.switchTo(this.state.previous, true);
      } else if (settings.request.action === 'rollback' && !this.state.previous) {
        this.state.lastRequestId = settings.request.id;
        await this.notice('Нет подтверждённого предыдущего выпуска для отката', `request:${settings.request.id}`);
      }
      await this.save();
    }
    if (this.stopping) return;
    if (this.blocked && this.worker?.exited && this.state.attempt?.phase === 'old-exiting') {
      this.blocked = false; this.state.phase = 'recovering';
      this.retryAt = Date.now() + (this.options.deferMs ?? 600_000);
      await this.save(); await this.recover(); return;
    }
    if (this.blocked) return;
    const attempt = this.state.attempt;
    if (attempt?.phase === 'rolling-back') {
      if (Date.now() >= this.retryAt) await this.rollback(new Error(attempt.failure ?? 'Продолжаю откат'), { quarantine: attempt.quarantineOnRollback !== false });
      return;
    }
    if (attempt?.phase === 'deferred' && attempt.manual) {
      if (Date.now() >= this.retryAt) await this.switchTo(attempt.to, true);
      return;
    }
    if (attempt?.phase === 'probation' && !attempt.manual && settings.enabled === false) {
      await this.rollback(new Error('Автоматическое применение выключено во время проверки'), { quarantine: false });
      return;
    }
    if (this.worker?.exited) {
      if (attempt?.phase === 'probation') {
        if (this.worker.fatal) { await this.rollback(this.worker.fatal); return; }
        attempt.candidateFatalCount++;
        await this.save();
        if (attempt.candidateFatalCount >= 3) await this.rollback(new Error('Три аварийных завершения кандидата'));
        else {
          await sleep((this.options.retryMs ?? [10_000, 30_000])[attempt.candidateFatalCount - 1], this.stopController.signal);
          if (!this.stopping) {
            attempt.candidateStartCount++; await this.save();
            try { await this.startWorker(attempt.to, attempt.id); }
            catch (error) { await this.rollback(error); }
          }
        }
      } else if (!attempt || attempt.phase === 'deferred') {
        this.state.activeCrashCount = (this.state.activeCrashCount ?? 0) + 1;
        await this.save();
        if (this.state.activeCrashCount >= 3) {
          this.blocked = true; this.state.phase = 'blocked'; this.state.deferredReason = 'Три аварии рабочего выпуска; требуется updates retry';
          await this.save(); return;
        }
        await sleep((this.options.retryMs ?? [10_000, 30_000])[this.state.activeCrashCount - 1], this.stopController.signal);
        if (this.stopping) return;
        await this.recover();
      }
      return;
    }
    if (attempt?.phase === 'probation') {
      if (this.clock() - this.activatedAt >= this.probationMs) await this.commit();
      this.deliverNotices(); await this.save(); return;
    }
    this.deliverNotices();
    if (this.clock() - this.activatedAt >= this.probationMs) this.state.activeCrashCount = 0;
    const version = this.state.installedVersion;
    if (!settings.enabled || !version || compareVersions(version, this.state.active.version) <= 0 || Date.now() < this.retryAt) { await this.save(); return; }
    if (version === this.observed) this.observations++; else { this.observed = version; this.observations = 1; }
    if (this.observations < (this.options.debounce ?? 3)) { await this.save(); return; }
    if (this.worker?.nextReminder && this.worker.nextReminder - Date.now() < 60_000 && this.worker.nextReminder > Date.now()) {
      this.state.deferredReason = 'Сначала отправлю ближайшее напоминание'; await this.save(); return;
    }
    if ((this.state.manualHold?.version === version) || this.state.quarantine?.some(q => q.version === version)) { await this.save(); return; }
    try {
      this.state.phase = 'preparing'; this.state.pendingVersion = version; await this.save();
      const target = await this.releaseStore.prepare(version, { signal: this.stopController.signal });
      if (this.stopping || !(await this.settings()).enabled || await this.installed() !== version) { this.state.phase = 'idle'; await this.save(); return; }
      if (!compatible(this.state.active, target)) throw new Error('Выпуск требует обслуживаемого обновления формата или supervisor');
      if (this.state.manualHold && version !== this.state.manualHold.version) this.state.manualHold = null;
      await this.switchTo(target);
      this.retryCount = 0;
    } catch (error) {
      this.state.deferredReason = detail(error);
      this.retryAt = Date.now() + [60_000, 300_000, 900_000, 3_600_000][Math.min(this.retryCount++, 3)];
      if (!this.blocked) this.state.phase = 'deferred';
      await this.save();
      if (!this.stopping) await this.notice(`Обновление ${version} отложено: ${detail(error)}`, `prepare:${version}:${detail(error)}`);
    }
  }

  requestStop() {
    if (this.stopping) return;
    this.stopping = true;
    this.stopController.abort();
    if (this.worker && !this.worker.exited) this.worker.child.kill('SIGTERM');
  }

  async run() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const unlock = await acquireLock(join(this.root, 'supervisor.lock'));
    const stop = () => this.requestStop();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      this.state = await readJSON(join(this.root, 'state.json'));
      if (this.state?.schemaVersion !== 1 || !this.state.active || !this.state.installation?.manifestPath) throw new Error('Runtime journal отсутствует или несовместим');
      this.retryAt = this.state.nextRetryAt ?? 0;
      this.retryCount = this.state.preparationRetryCount ?? 0;
      this.state.supervisorOwnerId = unlock.identity.ownerId;
      this.releaseStore ??= new ReleaseStore(this.home, { ...this.options, node: this.node, npm: this.state.installation.npm });
      await this.recover();
      while (!this.stopping) {
        try { await this.tick(); } catch (error) { this.blocked = true; this.state.phase = 'blocked'; this.state.deferredReason = detail(error); await this.save(); }
        await sleep(this.pollMs, this.stopController.signal);
      }
      if (this.worker && !await this.waitExit(this.worker, this.finishMs)) {
        // Do not leave a stale unlock that invites another writer.
        throw new Error('Worker ещё завершает остановку; runtime lock сохранён до выхода');
      }
      this.state.supervisorPid = null; this.state.runningVersion = null; await this.save();
    } catch (error) {
      // A rejected durable write must not leave a connected child keeping the
      // launcher alive after monitoring and its signal handlers have ended.
      this.requestStop();
      const worker = this.worker;
      if (worker && !worker.exited && !await this.waitExit(worker, this.finishMs)) {
        this.blocked = true;
        (this.options.log ?? console.error)('Fatal supervisor failure: worker exit is unconfirmed; ownership lock and signal handlers are retained');
        // Never trade an unconfirmed writer for a second one or force-kill an
        // active operation. Remain its guardian until its actual exit.
        await worker.exit;
      }
      throw error;
    } finally {
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      if (!this.worker || this.worker.exited) await unlock();
    }
  }
}
