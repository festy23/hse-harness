import { stringArray } from '../validation.js';
import { budgets, withOperation, type OperationContext } from '../operations.js';
import {
  deadline,
  hash,
  HISTORY_FROM,
  validateTask,
  moscowDate,
  type Calendar,
  type Lesson,
  type Task,
} from '../domain.js';
import type { Store } from '../store.js';
import type { CalendarCollection } from './collection.js';

export class StudyCalendar implements Calendar {
  constructor(
    readonly timetable: CalendarCollection,
    readonly agent: CalendarCollection,
  ) {
    if (timetable.identity === agent.identity) {
      throw new Error('Календарь дедлайнов должен отличаться от расписания');
    }
  }
  async listTasks(ctx?: OperationContext): Promise<Task[]> {
    return (await this.agent.list(ctx))
      .filter((e) => e.task && e.status !== 'cancelled')
      .map((e) => {
        const t = validateTask({ ...e.task! });
        if (t.deadline && e.start && +new Date(e.start) !== +new Date(t.deadline)) {
          t.deadline = deadline(e.start).value;
        }
        return t;
      });
  }
  async putTask(task: Task, ctx?: OperationContext): Promise<void> {
    const t = validateTask(task),
      id = hash(t.id).slice(0, 40);
    if (t.status === 'cancelled' || !t.deadline) {
      await this.agent.remove(id, ctx);
      return;
    }
    if (Buffer.byteLength(JSON.stringify(t)) > 20_000) {
      throw new Error('Описание слишком длинное; сократите notes/источники');
    }
    await this.agent.put(
      {
        id,
        title: `${t.status === 'submitted' ? '✓ ' : ''}${t.course}: ${t.title}`,
        start: t.deadline,
        end: new Date(+new Date(t.deadline) + 15 * 60_000).toISOString(),
        status: 'confirmed',
        task: t,
        description: `${t.notes}\nСтатус: ${t.status}\nОснование срока: ${t.deadlineBasis}${t.disputed ? '\nСрок спорный.' : ''}\nИсточники:\n${t.sources.join('\n')}`,
      },
      ctx,
    );
  }
  async lessons(from: string, to: string, ctx?: OperationContext): Promise<Lesson[]> {
    return (await this.timetable.range(from, to, ctx))
      .filter((e) => e.status !== 'cancelled' && e.start && e.end)
      .map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start!,
        end: e.end!,
        ...(e.allDay ? { allDay: true } : {}),
      }));
  }
  async changeLesson(
    id: string,
    start: string,
    end: string,
    ctx?: OperationContext,
  ): Promise<void> {
    const a = deadline(start).value,
      b = deadline(end).value;
    if (+new Date(b) <= +new Date(a)) {
      throw new Error('Некорректный интервал занятия');
    }
    await this.timetable.move(id, a, b, ctx);
  }
  async lessonPreview(id: string, ctx?: OperationContext): Promise<string> {
    const event = await this.timetable.get(id, ctx);
    if (event.status === 'cancelled') {
      throw new Error('Занятие уже отменено');
    }
    return `${event.title}\nСейчас: ${event.start ?? 'Неизвестно'} → ${event.end ?? 'Неизвестно'}`;
  }
  async lessonMatches(
    id: string,
    start: string,
    end: string,
    ctx?: OperationContext,
  ): Promise<boolean> {
    const event = await this.timetable.get(id, ctx);
    if (event.status === 'cancelled' || !event.start || !event.end) {
      return false;
    }
    if (event.allDay) {
      return (
        event.start === moscowDate(+new Date(deadline(start).value)) &&
        event.end === moscowDate(+new Date(deadline(end).value))
      );
    }
    return (
      deadline(event.start).value === deadline(start).value &&
      deadline(event.end).value === deadline(end).value
    );
  }
  async syncSchedule(
    store: Store,
    ctx?: OperationContext,
  ): Promise<{ complete: boolean; initialComplete: boolean }> {
    return withOperation('source', budgets.calendarScan, ctx, async (op) => {
      const key = this.timetable.identity,
        snapshotKey = `calendarSnapshot:${key}`;
      const result = await this.timetable.changes(store.state.calendarTokens[key], op);
      op.throwIfAborted();
      const before = new Set(stringArray(JSON.parse(store.state.cursors[snapshotKey] ?? '[]')));
      const current = result.full ? new Set<string>() : new Set(before);
      const events = [...result.events];
      for (const e of events) {
        if (e.status === 'cancelled') {
          current.delete(e.id);
        } else {
          current.add(e.id);
        }
      }
      const eventIds = new Set(events.map((e) => e.id));
      if (result.full) {
        for (const id of before) {
          if (!current.has(id) && !eventIds.has(id)) {
            events.push({ id, title: 'Занятие удалено из расписания', status: 'cancelled' });
          }
        }
      }
      const sources = events.map((e) => ({
        id: `calendar:${key}:${e.id}`,
        kind: 'calendar' as const,
        date: e.start ?? HISTORY_FROM,
        text: JSON.stringify({
          title: e.title,
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          status: e.status,
          description: e.description,
          recurrence: e.recurrence,
        }),
        deleted: e.status === 'cancelled',
      }));
      for (let i = 0; i < sources.length; i += 20) {
        op.throwIfAborted();
        await store.enqueue(sources.slice(i, i + 20));
      }
      op.throwIfAborted();
      store.state.cursors[snapshotKey] = JSON.stringify([...current]);
      if (result.cursor) {
        store.state.calendarTokens[key] = result.cursor;
      } else {
        delete store.state.calendarTokens[key];
      }
      await store.save();
      return { complete: true, initialComplete: true };
    });
  }
}
