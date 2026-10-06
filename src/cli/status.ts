import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type CalendarSelection } from '../config.js';
import type { SetupSection } from './ports.js';
import type { SetupState } from './state.js';
import { icons, modelMark, messengerMark, providerLabel } from './icons.js';

export interface StatusRow { id: SetupSection; title: string; ready: boolean; detail: string }
export interface SetupReport { rows: StatusRow[]; completed: number; total: number; pid?: number; name?: string }

function calendarLabel(value: CalendarSelection): string {
  const provider = { google: 'Google', yandex: 'Яндекс', icloud: 'iCloud' }[value.provider];
  return !value.id || value.id.startsWith('your-') ? 'не выбран' : value.label ? `${value.label} (${provider})` : `${provider} · календарь выбран`;
}
export function hasSubscription(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('openai' in value)) return false;
  const auth = value.openai;
  return Boolean(auth && typeof auth === 'object' && 'type' in auth && auth.type === 'oauth' &&
    'access' in auth && typeof auth.access === 'string' && auth.access &&
    'refresh' in auth && typeof auth.refresh === 'string' && auth.refresh &&
    'expires' in auth && typeof auth.expires === 'number' && Number.isFinite(auth.expires));
}
export function hasGoogleAuth(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const auth = value as Record<string, unknown>;
  return typeof auth.access_token === 'string' && Boolean(auth.access_token) && typeof auth.refresh_token === 'string' && Boolean(auth.refresh_token) && typeof auth.expires_at === 'number' && Number.isFinite(auth.expires_at);
}

/** Reports saved prerequisites without creating an SDK runtime or probing accounts. */
export async function setupReport(state: SetupState, pid?: number, env = process.env, authDir = state.authDir): Promise<SetupReport> {
  const contents = async (file: string) => readFile(join(authDir, file), 'utf8').catch(() => '');
  const [session, authText, googleText] = await Promise.all([contents('telegram.session'), contents('pi-auth.json'), contents('google.json')]);
  let auth: unknown;
  try { auth = JSON.parse(authText); } catch { auth = undefined; }
  let google: { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown } | undefined;
  try { google = JSON.parse(googleText); } catch { google = undefined; }
  const config = state.config;
  const timetable = calendarLabel(config.calendars.timetable);
  const agent = calendarLabel(config.calendars.agent);
  const providerReady = {
    icloud: Boolean(env.ICLOUD_USERNAME && env.ICLOUD_APP_PASSWORD),
    yandex: Boolean(env.YANDEX_CALENDAR_USERNAME && env.YANDEX_CALENDAR_APP_PASSWORD),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && hasGoogleAuth(google)),
  };
  const calendarLogin = providerReady[config.calendars.timetable.provider] && providerReady[config.calendars.agent.provider];
  const rows: StatusRow[] = [
    { id: 'profile', title: `${icons.profile} Профиль`, ready: Boolean(config.profile), detail: config.profile ? `${config.profile.group} · ${config.profile.course} курс · ${config.profile.academicYear}` : 'заполни курс и предметы' },
    { id: 'telegram', title: providerLabel(messengerMark('telegram')), ready: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH && config.ownerId && session.trim()), detail: `${config.chats.length} выбранных чатов${config.ownerId ? ' · владелец определён' : ' · нужен вход'}` },
    { id: 'mail', title: `${icons.mail} Яндекс Почта`, ready: Boolean(env.YANDEX_ADDRESS && env.YANDEX_APP_PASSWORD), detail: env.YANDEX_ADDRESS ? `папки: ${config.folders.join(', ') || 'все учебные'}` : 'не настроена' },
    { id: 'model', title: `${providerLabel(modelMark('openai'))} · Подписка LLM`, ready: hasSubscription(auth) && Boolean(config.model && !config.model.startsWith('choose-')), detail: `${hasSubscription(auth) ? 'вход сохранён' : 'нужен вход'} · ${config.model && !config.model.startsWith('choose-') ? config.model : 'модель не выбрана'}` },
    { id: 'calendars', title: `${icons.calendars} Календари`, ready: timetable !== 'не выбран' && agent !== 'не выбран' && calendarLogin, detail: `расписание: ${timetable}\nдедлайны: ${agent}${calendarLogin ? '' : '\nнужно подключить аккаунт календаря'}` },
  ];
  return { rows, completed: rows.filter(row => row.ready).length, total: rows.length, pid, name: config.profile?.name };
}
