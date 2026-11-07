import { createDAVClient, type DAVCalendar } from 'tsdav';
import { secret } from '../../config.js';
import { CalDAVCollection } from './caldav.js';
import { budgets, withOperation, type OperationContext } from '../../operations.js';
import { limitedResponse } from '../http.js';

export function yandexUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'caldav.yandex.ru' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Нужен HTTPS URL календаря caldav.yandex.ru');
  }
  return url;
}
export const yandexFetch: typeof fetch = async (input, options) => {
  let url = yandexUrl(
    typeof input === 'string' || input instanceof URL ? String(input) : input.url,
  );
  for (let n = 0; n < 5; n++) {
    const response = await fetch(url, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.any([
        AbortSignal.timeout(budgets.calendarRequest),
        ...(options?.signal ? [options.signal] : []),
      ]),
    });
    if (response.status >= 300 && response.status < 400) {
      const next = yandexUrl(new URL(response.headers.get('location') ?? '', url).href);
      await response.body?.cancel();
      url = next;
      continue;
    }
    if (response.status >= 400 && response.status !== 404) {
      await response.body?.cancel();
      throw new Error(`Яндекс CalDAV: HTTP ${response.status}`);
    }
    return limitedResponse(response);
  }
  throw new Error('Слишком много перенаправлений Яндекс CalDAV');
};
export class YandexAccount {
  async calendars(ctx?: OperationContext): Promise<DAVCalendar[]> {
    return withOperation('connect', budgets.calendarScan, ctx, async (op) => {
      const client = await this.connect(op);
      return client.fetchCalendars({ fetchOptions: { signal: op.signal } });
    });
  }
  private async connect(ctx: OperationContext) {
    let discovering = true;
    const client = await createDAVClient({
      serverUrl: 'https://caldav.yandex.ru',
      credentials: {
        username: secret('YANDEX_CALENDAR_USERNAME'),
        password: secret('YANDEX_CALENDAR_APP_PASSWORD'),
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
      fetch: (input, options) =>
        yandexFetch(input, {
          ...options,
          signal: options?.signal ?? (discovering ? ctx.signal : undefined),
        }),
    });
    discovering = false;
    return client;
  }
  async collection(id: string, ctx?: OperationContext): Promise<CalDAVCollection> {
    const url = yandexUrl(id);
    if (!url.pathname.endsWith('/')) {
      throw new Error('URL календаря должен заканчиваться /');
    }
    return withOperation('connect', budgets.calendarScan, ctx, async (op) => {
      const client = await this.connect(op);
      const calendar = (await client.fetchCalendars({ fetchOptions: { signal: op.signal } })).find(
        (c) => yandexUrl(c.url).href === url.href,
      );
      if (!calendar) {
        throw new Error('Выбранный календарь не найден; повторите выбор календаря');
      }
      return new CalDAVCollection(client, calendar, `yandex:${url.href}`);
    });
  }
}
