import { asError } from '../operations.js';
import type { BotUpdate } from '../bot.js';
import type { Store } from '../store.js';
import type { WorkerLifecycle } from './lifecycle.js';

interface Entry {
  update: BotUpdate;
  state: 'waiting' | 'running' | 'done';
  retryAt: number;
  callback: 'waiting' | 'running' | 'done';
}

export class CommandCoordinator {
  private readonly entries = new Map<number, Entry>();
  private readonly jobs = new Set<Promise<void>>();
  private callbacks = 0;
  private fast = 0;
  private slow = 0;
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  constructor(
    private readonly lifecycle: WorkerLifecycle,
    private readonly store: Store,
    private readonly handle: (update: BotUpdate) => Promise<void>,
    private readonly options: {
      isFast: (update: BotUpdate) => boolean;
      onError: (error: unknown) => Promise<void>;
      fastConcurrency?: number;
      slowCapacity?: number;
      answerCallback?: (id: string) => Promise<void>;
      retryMs?: number;
    },
  ) {}
  observe(updates: BotUpdate[]): void {
    this.check();
    for (const update of updates) {
      if (update.update_id < this.store.state.botOffset || this.entries.has(update.update_id)) {
        continue;
      }
      if (this.entries.size >= 100) {
        break;
      }
      this.entries.set(update.update_id, {
        update,
        state: 'waiting',
        retryAt: 0,
        callback: update.callback_query && this.options.answerCallback ? 'waiting' : 'done',
      });
    }
    this.pump();
  }
  private ordered(): Entry[] {
    return [...this.entries.values()].sort((a, b) => a.update.update_id - b.update.update_id);
  }
  private answerCallbacks(): void {
    for (const entry of this.ordered()) {
      if (this.callbacks >= 4) {
        break;
      }
      if (entry.callback !== 'waiting') {
        continue;
      }
      entry.callback = 'running';
      this.callbacks++;
      const job = this.lifecycle
        .run(async () => {
          await this.options.answerCallback!(entry.update.callback_query!.id);
        })
        .then(
          () => {},
          (error) => {
            this.failure = error;
          },
        )
        .finally(() => {
          entry.callback = 'done';
          this.callbacks--;
          this.jobs.delete(job);
          this.pump();
        });
      this.jobs.add(job);
    }
  }
  private pump(): void {
    if (!this.lifecycle.accepting || this.failure) {
      return;
    }
    this.answerCallbacks();
    for (const entry of this.ordered()) {
      if (entry.state !== 'waiting' || entry.retryAt > Date.now()) {
        continue;
      }
      const fast = this.options.isFast(entry.update);
      if (
        fast
          ? this.fast >= (this.options.fastConcurrency ?? 2)
          : this.slow >= (this.options.slowCapacity ?? 32)
      ) {
        continue;
      }
      entry.state = 'running';
      if (fast) {
        this.fast++;
      } else {
        this.slow++;
      }
      const previous = this.tail;

      const job = this.lifecycle
        .run(async () => {
          if (!fast) {
            await previous;
          }
          try {
            await this.handle(entry.update);
            entry.state = 'done';
          } catch (error) {
            entry.state = 'waiting';
            entry.retryAt = Date.now() + (this.options.retryMs ?? 3000);
            await this.options.onError(error);
          }
        })
        .then(
          () => {},
          (error) => {
            this.failure = error;
          },
        )
        .finally(() => {
          if (fast) {
            this.fast--;
          } else {
            this.slow--;
          }
          this.jobs.delete(job);
          this.pump();
        });
      this.jobs.add(job);
      if (!fast) {
        this.tail = job;
      }
    }
  }
  check(): void {
    if (this.failure) {
      throw asError(this.failure);
    }
  }
  async advance(): Promise<void> {
    this.check();
    const completed: Entry[] = [];
    for (const entry of this.ordered()) {
      if (entry.state !== 'done' || entry.callback !== 'done') {
        break;
      }
      completed.push(entry);
    }
    if (!completed.length) {
      return;
    }
    this.store.state.botOffset = completed.at(-1)!.update.update_id + 1;
    await this.store.save();
    for (const entry of completed) {
      this.entries.delete(entry.update.update_id);
    }
    this.pump();
  }
  async idle(): Promise<void> {
    while (this.jobs.size) {
      await Promise.all([...this.jobs]);
    }
    this.check();
  }
  status() {
    return {
      observed: this.entries.size,
      fast: this.fast,
      slow: this.slow,
      waiting: [...this.entries.values()].filter((e) => e.state === 'waiting').length,
    };
  }
}
