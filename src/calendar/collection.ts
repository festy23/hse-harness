import type { Task } from '../domain.js';

/** A remote calendar collection. Providers own transport, recurrence, ETags and serialization. */
export interface CalendarEvent {
  id:string;
  title:string;
  description?:string;
  start?:string;
  end?:string;
  allDay?:boolean;
  status?:'confirmed'|'cancelled';
  /** Read-only series metadata; modify a selected occurrence through move(). */
  recurrence?:string;
  task?:Task;
}
export interface CalendarChanges {events:CalendarEvent[];cursor?:string;full:boolean}
export interface CalendarCollection {
  /** Stable provider + account + collection identity, used to namespace sync checkpoints. */
  readonly identity:string;
  list():Promise<CalendarEvent[]>;
  range(from:string,to:string):Promise<CalendarEvent[]>;
  changes(cursor?:string):Promise<CalendarChanges>;
  get(id:string):Promise<CalendarEvent>;
  /** Upsert a standalone event managed by the application (such as a deadline). */
  put(event:CalendarEvent):Promise<void>;
  remove(id:string):Promise<void>;
  /** Move this occurrence only; preserve its unrelated fields and recurrence series. */
  move(id:string,start:string,end:string):Promise<void>;
}
