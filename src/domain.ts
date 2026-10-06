import { createHash } from 'node:crypto';

export const TZ = 'Europe/Moscow';
export const HISTORY_FROM = '2026-09-01T00:00:00+03:00';
export type Status = 'open' | 'done' | 'submitted' | 'cancelled';
export interface Source {
  id: string;
  kind: 'telegram' | 'mail' | 'web' | 'owner' | 'calendar';
  text: string;
  date: string;
  author?: string;
  url?: string;
  replyTo?: string;
  deleted?: boolean;
}
export interface Task {
  id: string;
  title: string;
  course: string;
  status: Status;
  deadline?: string;
  deadlineBasis: 'explicit' | 'personal-date-rule' | 'schedule' | 'unknown';
  sources: string[];
  disputed: boolean;
  notes: string;
}
export interface Lesson { id: string; title: string; start: string; end: string; allDay?:boolean }
export interface Calendar {
  listTasks(): Promise<Task[]>;
  putTask(task: Task): Promise<void>;
  lessons(from: string, to: string): Promise<Lesson[]>;
  changeLesson(id: string, start: string, end: string): Promise<void>;
}
export interface Job { id: string; taskId: string; due: number; text: string }
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const taskVersion = (t: Task) => hash(JSON.stringify([t.id,t.title,t.course,t.status,t.deadline,t.disputed]));

export function deadline(value: string): { value: string; basis: Task['deadlineBasis'] } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const instant = new Date(value + 'T00:00:00+03:00');
    if (!Number.isFinite(+instant) || moscowDate(+instant) !== value) throw new Error('Некорректная дата');
    return { value: instant.toISOString(), basis: 'personal-date-rule' };
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('Укажите дату YYYY-MM-DD или ISO дату с часовым поясом');
  }
  const instant = new Date(value);
  const datePart=value.slice(0,10),day=new Date(datePart+'T00:00:00Z');
  if (!Number.isFinite(+instant) || !Number.isFinite(+day) || day.toISOString().slice(0,10)!==datePart || Number(value.slice(11,13))>23 || Number(value.slice(14,16))>59) throw new Error('Некорректное время');
  return { value: instant.toISOString(), basis: 'explicit' };
}
export function moscowDate(at: number): string {
  return new Date(at + 3 * 3600_000).toISOString().slice(0, 10);
}
export function moscowHour(at: number): number { return new Date(at + 3 * 3600_000).getUTCHours(); }
export function prettyTime(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {timeZone: TZ, dateStyle: 'medium', timeStyle: 'short'}).format(new Date(value));
}
export function reminderJobs(t: Task): Job[] {
  if (!t.deadline || ['submitted', 'cancelled'].includes(t.status)) return [];
  const time = +new Date(t.deadline);
  const suffix = t.disputed ? '\nСрок спорный: пока ориентируемся на самый ранний.' : '';
  const rule = t.deadlineBasis === 'personal-date-rule' ? '\nВремя определено твоим правилом даты без часа.' : '';
  return [[72, 'три дня'], [24, 'день'], [1, 'час']].map(([hours, label]) => ({
    id: `${t.id}:${hash(t.deadline!)}:${hours}`, taskId: t.id, due: time - Number(hours) * 3600_000,
    text: `До сдачи осталось ${label}: ${t.course} — ${t.title}\nСрок: ${prettyTime(t.deadline!)}${t.status === 'done' ? '\nРабота сделана, осталось сдать.' : ''}${suffix}${rule}`,
  }));
}

export function validateTask(t: Task): Task {
  if (!/^[a-z0-9_-]{1,80}$/.test(t.id) || !t.title.trim() || !t.course.trim()) throw new Error('Нужны стабильный id, название и предмет');
  if (!['open','done','submitted','cancelled'].includes(t.status)) throw new Error('Неизвестный статус');
  if (!['explicit','personal-date-rule','schedule','unknown'].includes(t.deadlineBasis)) throw new Error('Неизвестное основание срока');
  if (t.deadline) t = {...t, deadline: deadline(t.deadline).value};
  if (t.sources.length === 0) throw new Error('Нужен хотя бы один источник');
  return t;
}
