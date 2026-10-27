import { createDAVClient, type DAVCalendar } from 'tsdav';
import { secret } from '../../config.js';
import { CalDAVCollection } from './caldav.js';
import { budgets, withOperation, type OperationContext } from '../../operations.js';
import { limitedResponse } from '../http.js';

export function iCloudUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !(
      url.hostname === 'caldav.icloud.com' || /^[a-z0-9-]+-caldav\.icloud\.com$/i.test(url.hostname)
    )
  ) {
    throw new Error('Нужен HTTPS URL календаря iCloud CalDAV');
  }
  return url;
}

export const iCloudFetch: typeof fetch = async (input, options) => {
  let url = iCloudUrl(
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
      const next = iCloudUrl(new URL(response.headers.get('location') ?? '', url).href);
      await response.body?.cancel();
      url = next;
      continue;
    }
    if (response.status >= 400 && response.status !== 404) {
      await response.body?.cancel();
      throw new Error(`iCloud CalDAV: HTTP ${response.status}`);
    }
    return limitedResponse(response);
  }
  throw new Error('Слишком много перенаправлений iCloud CalDAV');
};
export class ICloudAccount {
  async calendars(ctx?: OperationContext): Promise<DAVCalendar[]> {
    return withOperation('connect', budgets.calendarScan, ctx, async (op) => {
      const client = await this.connect(op);
      return client.fetchCalendars({ fetchOptions: { signal: op.signal } });
    });
  }
  private async connect(ctx: OperationContext) {
    let discovering = true;
    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: secret('ICLOUD_USERNAME'), password: secret('ICLOUD_APP_PASSWORD') },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
      fetch: (input, options) =>
        iCloudFetch(input, {
          ...options,
          signal: options?.signal ?? (discovering ? ctx.signal : undefined),
        }),
    });
    discovering = false;
    return client;
  }
  async collection(id: string, ctx?: OperationContext): Promise<CalDAVCollection> {
    const url = iCloudUrl(id);
    if (!url.pathname.endsWith('/')) {
      throw new Error('URL календаря должен заканчиваться /');
    }
    return withOperation('connect', budgets.calendarScan, ctx, async (op) => {
      const client = await this.connect(op);
      const calendar = (await client.fetchCalendars({ fetchOptions: { signal: op.signal } })).find(
        (c) => iCloudUrl(c.url).href === url.href,
      );
      if (!calendar) {
        throw new Error('Выбранный календарь не найден; повторите выбор календаря');
      }
      return new CalDAVCollection(client, calendar, `icloud:${url.href}`);
    });
  }
}
