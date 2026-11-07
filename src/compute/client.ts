import { Worker } from 'node:worker_threads';
import {
  asError,
  createOperation,
  budgets,
  OperationError,
  type FailureKind,
  type OperationContext,
  type OperationScope,
} from '../operations.js';
import type { ComputeJob, HtmlComputeJob, HtmlComputeResult } from './jobs.js';

interface Pending {
  id: number;
  job: ComputeJob;
  scope: OperationScope;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  abort: () => void;
  finished: Promise<void>;
  markFinished: () => void;
  finishing?: boolean;
}

export class ComputeClient {
  private worker?: Worker;
  private active?: Pending;
  private readonly queue: Pending[] = [];
  private sequence = 0;
  private closed = false;
  constructor(
    private readonly options: { workerUrl?: URL; budgetMs?: number; maxQueued?: number } = {},
  ) {}
  run<T = unknown>(job: ComputeJob, ctx?: OperationContext): Promise<T> {
    if (this.closed) {
      return Promise.reject(new OperationError('cancelled', 'Вычислитель закрыт'));
    }
    if (this.active && this.queue.length >= (this.options.maxQueued ?? 8)) {
      return Promise.reject(new OperationError('rate-limit', 'Очередь вычислений заполнена'));
    }
    const scope = createOperation('cpu', this.options.budgetMs ?? budgets.cpu, ctx);
    return new Promise<T>((resolve, reject) => {
      let markFinished!: () => void;
      const finished = new Promise<void>((resolveFinished) => {
        markFinished = resolveFinished;
      });
      const item: Pending = {
        id: ++this.sequence,
        job,
        scope,
        resolve: (value) => resolve(value as T),
        reject,
        abort: () => {},
        finished,
        markFinished,
      };
      item.abort = () => {
        this.finishLater(
          item,
          undefined,
          scope.signal.reason ?? new OperationError('cancelled', 'Вычисление отменено'),
          true,
        );
      };
      scope.signal.addEventListener('abort', item.abort, { once: true });
      if (scope.signal.aborted) {
        scope.signal.removeEventListener('abort', item.abort);
        scope.dispose();
        reject(scope.signal.reason);
        return;
      }
      this.queue.push(item);
      this.pump();
    });
  }
  private startWorker(): Worker {
    const defaultUrl = import.meta.url.endsWith('.ts')
      ? new URL('../../dist/compute/worker.js', import.meta.url)
      : new URL('./worker.js', import.meta.url);
    const worker = new Worker(this.options.workerUrl ?? defaultUrl, {
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    worker.on(
      'message',
      (packet: {
        id: number;
        ok: boolean;
        value?: unknown;
        error?: { kind: FailureKind; message: string };
      }) => {
        if (this.active?.id !== packet.id) {
          return;
        }
        this.finishLater(
          this.active,
          packet.value,
          packet.ok
            ? undefined
            : new OperationError(
                packet.error?.kind ?? 'protocol',
                packet.error?.message ?? 'Вычисление не выполнено',
              ),
        );
      },
    );
    worker.on('error', () => {
      if (this.active) {
        this.finishLater(
          this.active,
          undefined,
          new OperationError('protocol', 'Вычислитель завершился с ошибкой'),
          true,
        );
      }
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.worker = undefined;
        if (this.active) {
          this.finishLater(
            this.active,
            undefined,
            new OperationError('protocol', `Вычислитель завершился (${code})`),
          );
        }
      }
    });
    worker.unref();
    return worker;
  }
  private pump(): void {
    if (this.active || this.closed) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    this.active = next;
    try {
      this.worker ??= this.startWorker();
      this.worker.ref();
      this.worker.postMessage({ id: next.id, job: next.job });
    } catch {
      this.finishLater(
        next,
        undefined,
        new OperationError('protocol', 'Не удалось запустить вычислитель'),
        true,
      );
    }
  }
  private finishLater(item: Pending, value?: unknown, error?: unknown, terminate = false): void {
    this.finish(item, value, error, terminate).catch((failure) => {
      queueMicrotask(() => {
        throw asError(failure);
      });
    });
  }
  private async finish(
    item: Pending,
    value?: unknown,
    error?: unknown,
    terminate = false,
  ): Promise<void> {
    if (item.finishing) {
      await item.finished;
      return;
    }
    item.finishing = true;
    if (error === undefined && item.scope.signal.aborted) {
      error = item.scope.signal.reason ?? new OperationError('cancelled', 'Вычисление отменено');
    }
    if (error === undefined && performance.now() >= item.scope.deadlineMonoMs) {
      error = new OperationError('deadline', 'Превышено время вычисления');
    }
    item.scope.signal.removeEventListener('abort', item.abort);
    item.scope.dispose();
    if (this.active === item) {
      if (terminate && this.worker) {
        const worker = this.worker;
        this.worker = undefined;
        await worker.terminate().catch(() => {});
      }
      this.active = undefined;
      this.worker?.unref();
    } else {
      const index = this.queue.indexOf(item);
      if (index >= 0) {
        this.queue.splice(index, 1);
      }
    }
    if (error !== undefined) {
      item.reject(error);
    } else {
      item.resolve(value);
    }
    item.markFinished();
    this.pump();
  }
  async close(): Promise<void> {
    this.closed = true;
    const error = new OperationError('cancelled', 'Вычислитель закрыт');
    for (const item of [...this.queue]) {
      await this.finish(item, undefined, error);
    }
    if (this.active) {
      await this.finish(this.active, undefined, error, true);
    }
    if (this.worker) {
      const worker = this.worker;
      this.worker = undefined;
      await worker.terminate();
    }
  }
}
const shared = new ComputeClient();
export function runCompute(job: HtmlComputeJob, ctx?: OperationContext): Promise<HtmlComputeResult>;
export function runCompute<T = unknown>(job: ComputeJob, ctx?: OperationContext): Promise<T>;
export function runCompute<T = unknown>(job: ComputeJob, ctx?: OperationContext): Promise<T> {
  return shared.run<T>(job, ctx);
}
export async function closeCompute(): Promise<void> {
  await shared.close();
}
