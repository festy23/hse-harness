import { spawn } from 'node:child_process';

/** Forward one interrupt to the complete child group and wait for graceful shutdown. */
export function runProcess(command, args, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: process.env, detached: process.platform !== 'win32' });
    let interrupted = false;
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    const signal = value => {
      if (interrupted || child.pid === undefined) return;
      interrupted = true;
      try {
        if (process.platform === 'win32') child.kill(value);
        else process.kill(-child.pid, value);
      } catch (error) {
        if (error.code === 'ESRCH') return;
        cleanup();
        reject(new Error('Не удалось передать остановку дочернему процессу'));
      }
    };
    const interrupt = () => signal('SIGINT');
    const terminate = () => signal('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.once('error', () => { cleanup(); reject(new Error('Не удалось запустить процесс. Проверь Node.js и npm')); });
    child.once('exit', (code, killedBy) => {
      cleanup();
      resolve(code ?? (killedBy === 'SIGINT' ? 130 : killedBy === 'SIGTERM' ? 143 : 1));
    });
  });
}
