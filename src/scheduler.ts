import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type Task,
  type Calendar,
  reminderJobs,
  moscowDate,
  moscowHour,
  prettyTime,
} from './domain.js';
import type { Store } from './store.js';
import type { Notifier } from './bot.js';
import { budgets, fatal, withOperation, type OperationContext } from './operations.js';

async function parallel<T>(items: T[], run: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const errors: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index++]!;
        try {
          await run(item);
        } catch (error) {
          errors.push(error);
        }
      }
    }),
  );
  if (errors.length) {
    throw errors.find(fatal) ?? errors[0];
  }
}

export class Scheduler {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly scope = new AsyncLocalStorage<Set<string>>();
  private readonly epochs = new Map<string, number>();
  constructor(
    readonly store: Store,
    readonly bot: Notifier,
  ) {}
  transaction<T>(run: () => Promise<T>, taskId?: string): Promise<T> {
    const key = taskId === undefined ? 'legacy' : `task:${taskId}`;
    return this.lock(key, run, taskId);
  }
  private lock<T>(key: string, run: () => Promise<T>, taskId?: string): Promise<T> {
    if (this.scope.getStore()?.has(key)) {
      return run();
    }
    if (taskId !== undefined) {
      this.epochs.set(taskId, (this.epochs.get(taskId) ?? 0) + 1);
    }
    const held = new Set(this.scope.getStore());
    held.add(key);
    const result = (this.tails.get(key) ?? Promise.resolve()).then(() => this.scope.run(held, run));
    const tail = result
      .then(
        () => {},
        () => {},
      )
      .then(() => {
        if (this.tails.get(key) === tail) {
          this.tails.delete(key);
        }
      });
    this.tails.set(key, tail);
    return result;
  }
  busy(taskId: string): boolean {
    return this.tails.has(`task:${taskId}`) && !this.scope.getStore()?.has(`task:${taskId}`);
  }
  private pending(taskId: string): boolean {
    return Object.values(this.store.state.taskOperations ?? {}).some(
      (op) => op.taskId === taskId && op.phase === 'pending',
    );
  }
  private operationVersion(taskId: string): string {
    return JSON.stringify(
      Object.values(this.store.state.taskOperations ?? {}).filter((op) => op.taskId === taskId),
    );
  }
  async syncTask(taskId: string, task: Task | undefined): Promise<void> {
    await this.transaction(async () => {
      this.store.state.jobs = [
        ...this.store.state.jobs.filter((job) => job.taskId !== taskId),
        ...(task ? reminderJobs(task) : []),
      ];
      await this.store.save();
    }, taskId);
  }

  async sync(tasks: Task[]): Promise<void> {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const ids = new Set([...this.store.state.jobs.map((job) => job.taskId), ...byId.keys()]);
    await parallel([...ids], (id) => this.syncTask(id, byId.get(id)));
  }
  async refresh(calendar: Pick<Calendar, 'listTasks'>, ctx?: OperationContext): Promise<void> {
    const epochs = new Map(this.epochs);
    const ids = new Set([
      ...this.store.state.jobs.map((job) => job.taskId),
      ...Object.values(this.store.state.taskOperations ?? {}).map((op) => op.taskId),
    ]);
    const operations = new Map([...ids].map((id) => [id, this.operationVersion(id)]));
    const busy = new Set([...ids].filter((id) => this.busy(id)));
    const tasks = await withOperation('source', budgets.calendarScan, ctx, (op) =>
      calendar.listTasks(op),
    );
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const id of byId.keys()) {
      ids.add(id);
    }
    await parallel([...ids], async (id) => {
      const epoch = epochs.get(id) ?? 0,
        version = operations.get(id) ?? '[]';
      if (busy.has(id) || this.busy(id) || (this.epochs.get(id) ?? 0) !== epoch) {
        return;
      }
      await this.transaction(async () => {
        if (
          (this.epochs.get(id) ?? 0) !== epoch + 1 ||
          this.operationVersion(id) !== version ||
          Object.values(this.store.state.taskOperations ?? {}).some(
            (operation) =>
              operation.taskId === id && ['pending', 'applied'].includes(operation.phase),
          )
        ) {
          return;
        }
        await this.syncTask(id, byId.get(id));
      }, id);
    });
  }
  async tick(now = Date.now(), ctx?: OperationContext): Promise<void> {
    for (const op of Object.values(this.store.state.taskOperations ?? {})) {
      if (
        op.phase !== 'pending' ||
        (op as typeof op & { writeAttempted?: boolean }).writeAttempted === false ||
        this.busy(op.taskId)
      ) {
        continue;
      }
      const key = `calendar-uncertain:${op.id}`;
      if (this.store.state.delivered[key] || this.store.state.notices[key]) {
        continue;
      }
      this.store.state.notices[key] =
        `Изменение «${op.desiredTask.title}» ожидает проверки календаря. Срок и статус сейчас не подтверждены; проверь календарь. Автоматически повторять изменение не буду.`;
      await this.store.save();
    }
    const ids = [
      ...new Set(
        this.store.state.jobs
          .filter((job) => job.due <= now && !this.store.state.delivered[job.id])
          .map((job) => job.taskId),
      ),
    ];
    await parallel(
      [
        () => this.flushNotices(now, ctx),
        () =>
          parallel(ids, async (id) => {
            if (this.busy(id)) {
              return;
            }
            await this.transaction(async () => {
              if (this.pending(id)) {
                return;
              }
              const jobs = this.store.state.jobs
                .filter(
                  (job) =>
                    job.taskId === id && job.due <= now && !this.store.state.delivered[job.id],
                )
                .sort((a, b) => b.due - a.due);
              const latest = jobs[0];
              if (!latest) {
                return;
              }
              const late = now - latest.due > 120_000;
              await this.bot.send(
                late
                  ? `Напоминание восстановлено с задержкой.\n${latest.text.replace(/^До сдачи осталось[^:]*:/, 'Проверь актуальный срок:')}`
                  : latest.text,
                undefined,
                `reminder:${latest.id}`,
                ctx,
              );
              for (const job of jobs) {
                this.store.state.delivered[job.id] = now;
              }
              await this.store.save();
            }, id);
          }),
      ],
      (run) => run(),
    );
  }
  async urgent(
    t: Task,
    previous: Task | undefined,
    now = Date.now(),
    ctx?: OperationContext,
  ): Promise<void> {
    await this.transaction(async () => {
      const changed =
        previous &&
        (previous.deadline !== t.deadline ||
          (t.status === 'cancelled' && previous.status !== 'cancelled'));
      const near = !previous && t.deadline && +new Date(t.deadline) - now < 86400_000;
      if (!changed && !near) {
        return;
      }
      const key = `urgent:${t.id}:${t.deadline}:${t.status}`;
      for (const pending of Object.keys(this.store.state.notices)) {
        if (pending.startsWith(`urgent:${t.id}:`) && pending !== key) {
          delete this.store.state.notices[pending];
        }
      }
      if (this.store.state.delivered[key]) {
        await this.store.save();
        return;
      }
      this.store.state.notices[key] =
        t.status === 'cancelled'
          ? `Отмена: ${t.course} — ${t.title}`
          : `Изменение/близкий срок: ${t.course} — ${t.title}\n${t.deadline ? prettyTime(t.deadline) : 'Срок уточняется'}${t.disputed ? '\nСрок спорный.' : ''}`;
      await this.store.save();
      await this.flushNotices(now, ctx, key);
    }, t.id);
  }
  private noticeTask(key: string): string | undefined {
    if (key.startsWith('urgent:')) {
      return key.split(':')[1];
    }
    return Object.values(this.store.state.taskOperations ?? {}).find(
      (op) => key === `calendar-conflict:${op.id}` || key === `calendar-uncertain:${op.id}`,
    )?.taskId;
  }
  async flushNotices(now: number, ctx?: OperationContext, onlyKey?: string): Promise<void> {
    await parallel(onlyKey ? [onlyKey] : Object.keys(this.store.state.notices), async (key) => {
      const taskId = this.noticeTask(key);
      if (
        taskId !== undefined &&
        (this.busy(taskId) || (key.startsWith('urgent:') && this.pending(taskId)))
      ) {
        return;
      }
      const send = async () => {
        const lock = `notice:${key}`;
        if (this.tails.has(lock) && !this.scope.getStore()?.has(lock)) {
          return;
        }
        await this.lock(lock, async () => {
          const text = this.store.state.notices[key];
          if (text === undefined) {
            return;
          }
          if (!this.store.state.delivered[key]) {
            await this.bot.send(text, undefined, key, ctx);
          }
          this.store.state.delivered[key] = now;
          delete this.store.state.notices[key];
          await this.store.save();
        });
      };
      if (taskId === undefined) {
        await send();
      } else {
        await this.transaction(send, taskId);
      }
    });
  }
  async digests(now = Date.now()): Promise<void> {
    const hour = moscowHour(now);
    for (const start of [10, 20]) {
      const id = `digest:${moscowDate(now)}:${start}`;
      if (
        this.store.state.delivered[id] ||
        this.store.state.missedDigests[id] ||
        this.store.state.queue.some((item) => item.id === id)
      ) {
        continue;
      }
      if (hour >= start && hour < start + 2) {
        this.store.state.queue.push({
          id,
          sources: [],
          digest: start === 10 ? 'morning' : 'evening',
        });
      } else if (hour >= start + 2) {
        this.store.state.missedDigests[id] = now;
      } else {
        continue;
      }
      await this.store.save();
    }
  }
  nextReminder(now = Date.now()): number | undefined {
    return this.store.state.jobs
      .filter((job) => !this.store.state.delivered[job.id] && job.due >= now)
      .sort((a, b) => a.due - b.due)[0]?.due;
  }
}
