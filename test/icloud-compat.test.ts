import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installCalDAVCollectionCompatibility } from '../deploy/icloud-compat.mjs';

test('legacy adapter compatibility excludes collection and foreign hrefs while retaining extensionless resources', async () => {
  type Request = { objectUrls?: string[]; urlFilter: (url: string) => boolean };
  let request: Request | undefined;
  class LegacyCollection {
    calendar = { url: 'https://caldav.icloud.com/agent/' };
    client = {
      fetchCalendarObjects: async (args: Request) => {
        request = args;
        return [];
      },
    };
    async objects(_urls?: string[]) {
      throw Error('Old adapter');
    }
  }
  installCalDAVCollectionCompatibility(LegacyCollection);
  const backend = new LegacyCollection(),
    urls = ['https://caldav.icloud.com/agent/id'];
  await backend.objects(urls);
  assert.ok(request);
  assert.equal(request.objectUrls, urls);
  for (const url of [
    'https://caldav.icloud.com/agent/',
    'https://caldav.icloud.com/elsewhere/file.ics',
    'https://elsewhere.example/agent/file.ics',
    'https://caldav.icloud.com/agent/subfolder/',
  ]) {
    assert.equal(request.urlFilter(url), false);
  }
  for (const url of [
    'https://caldav.icloud.com/agent/event.ics',
    'https://caldav.icloud.com/agent/opaque-id',
  ]) {
    assert.equal(request.urlFilter(url), true);
  }
});
