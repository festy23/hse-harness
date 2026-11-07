import { readFileSync, appendFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const options = JSON.parse(readFileSync(new URL('../fixture.json', import.meta.url), 'utf8'));
const home = process.env.HSE_HARNESS_HOME;
const version = process.env.HSE_RELEASE_VERSION;
const workerId = process.env.HSE_WORKER_ID;
const writer = join(home, 'fixture.writer');
let mode = 'preparing';
let owned = false;
let context;
let pendingDrain;
function event(type, more = {}) {
  appendFileSync(
    join(home, 'fixture.events'),
    JSON.stringify({ type, version, pid: process.pid, ...more }) + '\n',
  );
}
function send(message, type, extra = {}) {
  if (process.connected) {
    process.send({ ...message, protocolVersion: 1, workerId, type, ...extra });
  }
}
function release() {
  if (owned) {
    unlinkSync(writer);
    owned = false;
  }
}
function stop(cause) {
  event('stop', { cause });
  release();
  process.exit(0);
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('disconnect', () => {
  if (options.ignoreDisconnect) {
    event('orphan-disconnect');
  } else {
    stop('disconnect');
  }
});
process.on('message', (message) => {
  context = message;
  event(message.type, { sequence: message.sequence });
  if (message.type === 'prepare') {
    if (options.bootFail) {
      return send(message, 'boot-failed', { detail: 'fixture local runtime failure' });
    }
    setTimeout(() => send(message, 'boot-ready'), options.bootDelay ?? 0);
  } else if (message.type === 'activate') {
    try {
      writeFileSync(writer, String(process.pid), { flag: 'wx' });
      owned = true;
    } catch {
      event('overlap');
      process.exit(70);
    }
    mode = 'active';
    appendFileSync(join(home, 'fixture.data'), version + '\n');
    send(message, 'active');
    if (options.crashOnActive) {
      setTimeout(() => {
        event('crash');
        release();
        process.exit(1);
      }, 15);
    }
  } else if (message.type === 'drain') {
    mode = 'draining';
    if (
      options.ignoreDrain ||
      (options.drainGate && !existsSync(join(home, version + '.allow-drain')))
    ) {
      return;
    }
    pendingDrain = setTimeout(() => {
      mode = 'quiescent';
      event('quiescent');
      send(message, 'quiescent');
    }, options.drainDelay ?? 0);
  } else if (message.type === 'resume') {
    if (!options.lateQuiescent) {
      clearTimeout(pendingDrain);
    }
    mode = 'active';
    send(message, 'active');
  } else if (message.type === 'finish') {
    if (options.hangFinish) {
      return;
    }
    setTimeout(() => {
      event('finished');
      release();
      process.exit(0);
    }, options.finishDelay ?? 0);
  } else if (message.type === 'notice') {
    send(message, 'notice-sent', { id: message.id });
  }
});
if (!options.noHealth) {
  setInterval(() => {
    if (context && (!options.healthGate || existsSync(join(home, version + '.allow-health')))) {
      send(context, 'health', { mode });
    }
  }, options.healthIntervalMs ?? 10);
}
event('spawn');
