import { isRecord, parseRecord, record } from './validation.js';
import 'dotenv/config';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export type CalendarProvider = 'icloud' | 'google' | 'yandex';
export interface CalendarSelection {
  provider: CalendarProvider;
  id: string;
  label?: string;
}
export interface CalendarFeatures {
  googleCalendar: boolean;
  icloudCalendar: boolean;
  yandexCalendar?: boolean;
}
export interface StudyProfile {
  name: string;
  university: string;
  program: string;
  group: string;
  course: number;
  academicYear: string;
  subjects: string;
  details: string;
}
export const legacyProfile: StudyProfile = {
  name: 'Иван',
  university: 'ВШЭ ФКН',
  program: 'Программная инженерия',
  group: 'БПИ243',
  course: 3,
  academicYear: '2026/27',
  subjects: 'Кодинговые агенты в разработке',
  details: 'Набор 2024; поток C#; майнор: Финансовые рынки; НИС: Нейроинформатика',
};
export interface CalendarSettings {
  features: CalendarFeatures;
  calendars: { timetable: CalendarSelection; agent: CalendarSelection };
}
export interface TelegramChat {
  id: string;
  title: string;
  allowQuestions?: boolean;
}
export interface Config extends CalendarSettings {
  ownerId: number;
  chats: TelegramChat[];
  folders: string[];
  model: string;
  pollSeconds: number;
  profile?: StudyProfile;
}
export function assertCalendarEnabled(
  provider: CalendarProvider,
  features: CalendarFeatures,
): void {
  if (provider === 'google' && !features.googleCalendar) {
    throw new Error('Google Calendar отключен feature flag features.googleCalendar');
  }
  if (provider === 'icloud' && !features.icloudCalendar) {
    throw new Error('iCloud Calendar отключен feature flag features.icloudCalendar');
  }
  if (provider === 'yandex' && !features.yandexCalendar) {
    throw new Error('Яндекс Календарь отключен feature flag features.yandexCalendar');
  }
}
export function calendarSettings(value: unknown): CalendarSettings {
  const raw = value as Partial<CalendarSettings>;
  const features = { googleCalendar: false, icloudCalendar: true, ...raw.features };
  if (
    typeof features.googleCalendar !== 'boolean' ||
    typeof features.icloudCalendar !== 'boolean' ||
    (features.yandexCalendar !== undefined && typeof features.yandexCalendar !== 'boolean')
  ) {
    throw new Error('Календарные feature flags должны быть boolean');
  }
  const calendars = {
    timetable: { provider: 'icloud', id: 'your-icloud-timetable-url' },
    agent: { provider: 'icloud', id: 'your-icloud-agent-calendar-url' },
    ...raw.calendars,
  } as CalendarSettings['calendars'];
  for (const selection of Object.values(calendars)) {
    if (
      !selection ||
      !['icloud', 'google', 'yandex'].includes(selection.provider) ||
      typeof selection.id !== 'string' ||
      !selection.id.trim()
    ) {
      throw new Error('Укажите provider/id для каждой календарной роли');
    }
    assertCalendarEnabled(selection.provider, features);
  }
  if (
    calendars.timetable.provider === calendars.agent.provider &&
    calendars.timetable.id === calendars.agent.id
  ) {
    throw new Error('Нужны два разных календаря: расписание и дедлайны');
  }
  return { features, calendars };
}
export async function readConfigFile(): Promise<Record<string, unknown>> {
  const path = process.env.STUDY_CONFIG ?? 'config.local.json';
  const contents = await readFile(path, 'utf8').catch((e) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Настрой агента: hse-harness setup (из исходников: npm run harness)');
    }
    throw e;
  });
  return parseRecord(contents);
}
function telegramChat(value: unknown): TelegramChat {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^-?\d+$/.test(value.id) ||
    typeof value.title !== 'string' ||
    (value.allowQuestions !== undefined && typeof value.allowQuestions !== 'boolean')
  ) {
    throw new Error(
      'chats должны содержать числовые id, title и необязательный boolean allowQuestions',
    );
  }
  return { id: value.id, title: value.title, allowQuestions: value.allowQuestions };
}
function studyProfile(value: unknown): StudyProfile {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.university !== 'string' ||
    typeof value.program !== 'string' ||
    typeof value.group !== 'string' ||
    typeof value.academicYear !== 'string' ||
    typeof value.subjects !== 'string' ||
    typeof value.details !== 'string' ||
    typeof value.course !== 'number' ||
    !Number.isInteger(value.course) ||
    value.course < 1 ||
    value.course > 6
  ) {
    throw new Error(
      'profile должен содержать имя, вуз, программу, группу, курс 1–6, учебный год, предметы и дополнительные сведения',
    );
  }
  return {
    name: value.name,
    university: value.university,
    program: value.program,
    group: value.group,
    course: value.course,
    academicYear: value.academicYear,
    subjects: value.subjects,
    details: value.details,
  };
}
export function parseConfig(value: unknown): Config {
  const raw = record(value);
  if (('timetableId' in raw || 'agentCalendarId' in raw) && !raw.calendars) {
    throw new Error(
      'Обновите старый формат календарей по config.example.json: Google теперь отключен, провайдер выбирается явно',
    );
  }
  if (typeof raw.ownerId !== 'number' || !Number.isSafeInteger(raw.ownerId) || raw.ownerId <= 0) {
    throw new Error('Укажите ownerId в config.local.json');
  }
  if (!Array.isArray(raw.chats)) {
    throw new Error(
      'chats должны содержать числовые id, title и необязательный boolean allowQuestions',
    );
  }
  const folders: unknown = raw.folders === undefined ? [] : raw.folders;
  if (
    !Array.isArray(folders) ||
    !folders.every((folder: unknown): folder is string => typeof folder === 'string')
  ) {
    throw new Error('folders должен быть списком названий папок');
  }
  const model = raw.model === undefined ? '' : raw.model;
  if (typeof model !== 'string') {
    throw new Error('model должен быть строкой');
  }
  const pollSeconds = raw.pollSeconds === undefined ? 60 : raw.pollSeconds;
  if (
    typeof pollSeconds !== 'number' ||
    !Number.isFinite(pollSeconds) ||
    pollSeconds * 1000 > 2147483647
  ) {
    throw new Error('pollSeconds должен быть конечным числом не больше 2147483.647');
  }
  return {
    ...calendarSettings(raw),
    ownerId: raw.ownerId,
    chats: raw.chats.map(telegramChat),
    model,
    folders,
    pollSeconds: Math.max(15, pollSeconds),
    profile: raw.profile === undefined ? undefined : studyProfile(raw.profile),
  };
}
export async function loadConfig(): Promise<Config> {
  return parseConfig(await readConfigFile());
}
export function secret(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Не настроен ${name}; см. .env.example`);
  }
  return value;
}
export const dataDir = () => resolve(process.env.STUDY_DATA_DIR ?? 'data');
export const secretsDir = () => resolve(process.env.STUDY_SECRETS_DIR ?? 'secrets');
export async function directories(): Promise<void> {
  await Promise.all(
    [dataDir(), secretsDir(), join(dataDir(), 'pi')].map((p) =>
      mkdir(p, { recursive: true, mode: 0o700 }),
    ),
  );
}
