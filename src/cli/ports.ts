import type { CalendarProvider } from '../config.js';

export type SetupSection = 'profile' | 'telegram' | 'mail' | 'model' | 'calendars';
export interface Choice { id: string; label: string; hint?: string; writable?: boolean }
export interface InputRequest {
  message: string;
  initial?: string;
  secret?: boolean;
  optional?: boolean;
  validate?: (value: string) => string | undefined;
  signal?: AbortSignal;
}
export interface SetupUI {
  input(request: InputRequest): Promise<string>;
  choose(message: string, choices: Choice[], initial?: string): Promise<string>;
  many(message: string, choices: Choice[], selected: string[]): Promise<string[]>;
  yes(message: string, initial?: boolean): Promise<boolean>;
  note(message: string, title?: string): void;
  task<T>(message: string, action: (signal?: AbortSignal) => Promise<T>): Promise<T>;
}
export interface SetupConnections {
  bot(token: string, ui: SetupUI): Promise<string>;
  telegram(ui: SetupUI, expectedOwnerId?: number): Promise<{ ownerId: number; chats: Choice[] }>;
  mail(ui: SetupUI): Promise<Choice[]>;
  models(ui: SetupUI, reconnect: boolean): Promise<Choice[]>;
  calendars(provider: CalendarProvider, ui: SetupUI, reconnect: boolean): Promise<Choice[]>;
}
