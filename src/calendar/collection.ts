import type { Task } from '../domain.js';
import type { OperationContext } from '../operations.js';

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  status?: 'confirmed' | 'cancelled';

  recurrence?: string;
  task?: Task;
}
export interface CalendarChanges {
  events: CalendarEvent[];
  cursor?: string;
  full: boolean;
}
export interface CalendarCollection {
  readonly identity: string;
  list(ctx?: OperationContext): Promise<CalendarEvent[]>;
  range(from: string, to: string, ctx?: OperationContext): Promise<CalendarEvent[]>;
  changes(cursor?: string, ctx?: OperationContext): Promise<CalendarChanges>;
  get(id: string, ctx?: OperationContext): Promise<CalendarEvent>;

  put(event: CalendarEvent, ctx?: OperationContext): Promise<void>;
  remove(id: string, ctx?: OperationContext): Promise<void>;

  move(id: string, start: string, end: string, ctx?: OperationContext): Promise<void>;
}
