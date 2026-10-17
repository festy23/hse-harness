import type { Task } from '../domain.js';
import type {OperationContext} from '../operations.js';

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
  list(ctx?:OperationContext):Promise<CalendarEvent[]>;
  range(from:string,to:string,ctx?:OperationContext):Promise<CalendarEvent[]>;
  changes(cursor?:string,ctx?:OperationContext):Promise<CalendarChanges>;
  get(id:string,ctx?:OperationContext):Promise<CalendarEvent>;
  /** Upsert a standalone event managed by the application (such as a deadline). */
  put(event:CalendarEvent,ctx?:OperationContext):Promise<void>;
  remove(id:string,ctx?:OperationContext):Promise<void>;
  /** Move this occurrence only; preserve its unrelated fields and recurrence series. */
  move(id:string,start:string,end:string,ctx?:OperationContext):Promise<void>;
}
