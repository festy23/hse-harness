import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DAVCalendar } from 'tsdav';
import { secret, secretsDir, type CalendarProvider } from '../../config.js';
import { SetupCancelled, SetupIssue } from '../errors.js';
import type { Choice, SetupUI } from '../ports.js';
import { hasGoogleAuth } from '../status.js';

interface GoogleCalendarEntry {
  id: string;
  summary?: string;
  accessRole?: string;
}

interface GoogleCalendarPage {
  items?: GoogleCalendarEntry[];
  nextPageToken?: string;
}

export type CalendarListRequest = (path: string) => Promise<GoogleCalendarPage>;

/** Keep pagination here so both setup entry points can use the full account list. */
export async function googleCalendarChoices(request: CalendarListRequest): Promise<Choice[]> {
  const calendars = new Map<string, Choice>();
  const visited = new Set<string>();
  let pageToken: string | undefined;

  do {
    const query = new URLSearchParams({ maxResults: '250' });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await request(`users/me/calendarList?${query}`);

    if (page.items !== undefined && !Array.isArray(page.items)) {
      throw new SetupIssue('Google Calendar вернул некорректный список календарей. Повтори подключение.');
    }

    for (const calendar of page.items ?? []) {
      if (!calendar || typeof calendar.id !== 'string' || !calendar.id) continue;
      if (!['owner', 'writer', 'reader'].includes(calendar.accessRole ?? '')) continue;
      const writable = calendar.accessRole === 'owner' || calendar.accessRole === 'writer';
      calendars.set(calendar.id, {
        id: calendar.id,
        label: calendar.summary || 'Календарь без названия',
        writable,
        hint: writable ? 'чтение и запись' : 'только чтение',
      });
    }

    if (page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string') {
      throw new SetupIssue('Google Calendar вернул некорректную страницу. Повтори подключение.');
    }
    pageToken = page.nextPageToken || undefined;
    if (pageToken && visited.has(pageToken)) {
      throw new SetupIssue('Google Calendar повторяет страницу списка. Повтори подключение.');
    }
    if (pageToken) visited.add(pageToken);
  } while (pageToken);

  return [...calendars.values()];
}

/** DAV:write aggregates bind/unbind/write-content (RFC 3744 sections 3 and 5). */
export function caldavWritable(value: unknown): boolean | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const set = value as Record<string, unknown>;
  if (!('privilege' in set)) return Object.keys(set).length === 0 ? false : undefined;

  const privileges = Array.isArray(set.privilege) ? set.privilege : [set.privilege];
  if (privileges.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return undefined;
  const names = new Set(privileges.flatMap(item => Object.keys(item as Record<string, unknown>)));
  if (names.has('all') || names.has('write') || (
    names.has('bind') && names.has('unbind') && names.has('writeContent')
  )) return true;
  const known = new Set([
    'read', 'readAcl', 'readCurrentUserPrivilegeSet', 'writeAcl',
    'writeContent', 'writeProperties', 'bind', 'unbind', 'unlock',
  ]);
  // An unfamiliar aggregate may grant writing. Report it as unknown, never read-only.
  return names.size && [...names].every(name => known.has(name)) ? false : undefined;
}

export function caldavCalendarChoices(calendars: DAVCalendar[]): Choice[] {
  return calendars
    .filter(calendar => !calendar.components?.length || calendar.components.includes('VEVENT'))
    .map(calendar => {
      const writable = caldavWritable(calendar.projectedProps?.currentUserPrivilegeSet);
      return {
        id: calendar.url,
        label: typeof calendar.displayName === 'string' && calendar.displayName
          ? calendar.displayName : 'Календарь без названия',
        writable,
        hint: writable === undefined ? 'право записи не подтверждено'
          : writable ? 'чтение и запись' : 'только чтение',
      };
    });
}

export const calendarDiscoveryProperties = {
  'd:displayname': {},
  'd:resourcetype': {},
  'c:supported-calendar-component-set': {},
  'd:current-user-privilege-set': {},
};

interface CalDAVDiscovery {
  fetchCalendars(options: {
    props: typeof calendarDiscoveryProperties;
    projectedProps: Record<string, boolean>;
  }): Promise<DAVCalendar[]>;
}

export async function discoverCalDAVCalendars(client: CalDAVDiscovery): Promise<Choice[]> {
  const calendars = await client.fetchCalendars({
    props: calendarDiscoveryProperties,
    projectedProps: { currentUserPrivilegeSet: true },
  });
  return caldavCalendarChoices(calendars);
}

async function caldavChoices(provider: 'icloud' | 'yandex', signal?: AbortSignal): Promise<Choice[]> {
  if (signal?.aborted) throw new SetupCancelled();
  const { createDAVClient } = await import('tsdav');
  const cloud = provider === 'icloud';
  const protectedFetch = cloud
    ? (await import('../../calendar/providers/icloud.js')).iCloudFetch
    : (await import('../../calendar/providers/yandex.js')).yandexFetch;
  if (signal?.aborted) throw new SetupCancelled();
  const request: typeof fetch = async (input, options) => {
    if (signal?.aborted) throw new SetupCancelled();
    try {
      return await protectedFetch(input, {
        ...options,
        signal: AbortSignal.any([options?.signal ?? AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
      });
    } catch (error) {
      if (signal?.aborted) throw new SetupCancelled();
      throw error;
    }
  };
  const client = await createDAVClient({
    serverUrl: cloud ? 'https://caldav.icloud.com' : 'https://caldav.yandex.ru',
    credentials: {
      username: secret(cloud ? 'ICLOUD_USERNAME' : 'YANDEX_CALENDAR_USERNAME'),
      password: secret(cloud ? 'ICLOUD_APP_PASSWORD' : 'YANDEX_CALENDAR_APP_PASSWORD'),
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
    fetch: request,
  });
  if (signal?.aborted) throw new SetupCancelled();
  return discoverCalDAVCalendars(client);
}

export async function connectCalendars(
  provider: CalendarProvider,
  ui: SetupUI,
  reconnect: boolean,
): Promise<Choice[]> {
  const name = { google: 'Google Calendar', yandex: 'Яндекс Календарь', icloud: 'iCloud Calendar' }[provider];
  try {
    if (provider === 'google') {
      let saved: unknown;
      try { saved = JSON.parse(await readFile(join(secretsDir(), 'google.json'), 'utf8')); } catch { saved = undefined; }
      if (reconnect || !hasGoogleAuth(saved)) {
        const { authorizeGoogle } = await import('./google-auth.js');
        const cancellation = new AbortController();
        const interrupt = () => cancellation.abort();
        process.once('SIGINT', interrupt);
        try {
          await authorizeGoogle({
            notify: message => ui.note(message, 'Вход в Google'),
            signal: cancellation.signal,
          });
        } finally {
          process.off('SIGINT', interrupt);
        }
      }
      return await ui.task(`Получаю календари ${name}`, async (signal?: AbortSignal) => {
        if (signal?.aborted) throw new SetupCancelled();
        const { Google } = await import('../../google.js');
        if (signal?.aborted) throw new SetupCancelled();
        const api = new Google();
        // Google refresh can persist credentials: wait for its bounded request to
        // finish before rollback, rather than racing cancellation with a late write.
        return googleCalendarChoices(async path => {
          if (signal?.aborted) throw new SetupCancelled();
          try {
            const page = await api.request<GoogleCalendarPage>(path);
            if (signal?.aborted) throw new SetupCancelled();
            return page;
          } catch (error) {
            if (signal?.aborted) throw new SetupCancelled();
            throw error;
          }
        });
      });
    }
    return await ui.task(`Получаю календари ${name}`, (signal?: AbortSignal) => caldavChoices(provider, signal));
  } catch (error) {
    if (error instanceof SetupCancelled || error instanceof SetupIssue) throw error;
    throw new SetupIssue(`${name}: не удалось получить календари. Проверь аккаунт, пароль приложения и соединение.`);
  }
}
