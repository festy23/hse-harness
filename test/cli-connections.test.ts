import test from 'node:test';
import assert from 'node:assert/strict';
import {
  caldavCalendarChoices,
  caldavWritable,
  discoverCalDAVCalendars,
  googleCalendarChoices,
} from '../src/cli/connections/calendars.js';
import { mailFolderChoices } from '../src/cli/connections/mail.js';
import { SetupIssue } from '../src/cli/errors.js';

test('Google calendar discovery visits all pages, deduplicates IDs and distinguishes reading/writing', async () => {
  const paths: string[] = [];
  const choices = await googleCalendarChoices(async path => {
    paths.push(path);
    if (paths.length === 1) return {
      items: [
        { id: 'schedule', summary: 'Занятия', accessRole: 'reader' },
        { id: 'hidden', summary: 'Только занятость', accessRole: 'freeBusyReader' },
        { id: 'deadlines', summary: 'Дедлайны', accessRole: 'owner' },
      ],
      nextPageToken: 'a page+token',
    };
    return { items: [
      { id: 'deadlines', summary: 'Дедлайны', accessRole: 'owner' },
      { id: 'shared', summary: 'Совместный', accessRole: 'writer' },
      { id: 'unknown', summary: 'Неизвестные права' },
    ] };
  });

  assert.equal(paths.length, 2);
  assert.equal(new URL(paths[1]!, 'https://example.test').searchParams.get('pageToken'), 'a page+token');
  assert.deepEqual(choices.map(choice => [choice.id, choice.writable]), [
    ['schedule', false], ['deadlines', true], ['shared', true],
  ]);
  assert.equal(choices[0]!.hint, 'только чтение');
});

test('Google calendar discovery rejects repeated pagination instead of looping', async () => {
  let requests = 0;
  await assert.rejects(googleCalendarChoices(async () => {
    requests += 1;
    return { items: [], nextPageToken: 'repeated' };
  }), SetupIssue);
  assert.equal(requests, 2);
});

test('CalDAV privilege choices preserve unknown permissions and distinguish writable, read-only and non-event calendars', async () => {
  const choices = await discoverCalDAVCalendars({
    async fetchCalendars(options) {
      assert.deepEqual(options.props['d:current-user-privilege-set'], {});
      assert.equal(options.projectedProps.currentUserPrivilegeSet, true);
      return [
        { url: 'https://calendar.test/readonly/', displayName: 'Занятия', projectedProps: { currentUserPrivilegeSet: { privilege: { read: {} } } } },
        { url: 'https://calendar.test/write/', displayName: 'Дедлайны', projectedProps: { currentUserPrivilegeSet: { privilege: [{ read: {} }, { write: {} }] } } },
        { url: 'https://calendar.test/unknown/', displayName: 'Неизвестно' },
        { url: 'https://calendar.test/todos/', components: ['VTODO'] },
      ];
    },
  });
  assert.deepEqual(choices.map(choice => choice.writable), [false, true, undefined]);
  assert.equal(choices[2]!.hint, 'право записи не подтверждено');
  assert.equal(caldavWritable({ privilege: [{ bind: {} }, { unbind: {} }, { writeContent: {} }] }), true);
  assert.equal(caldavWritable({ privilege: { writeContent: {} } }), false);
  assert.equal(caldavWritable({ privilege: { serverSpecific: {} } }), undefined);
  assert.equal(caldavWritable({ privilege: 'malformed' }), undefined);
  assert.equal(caldavCalendarChoices([{ url: 'https://calendar.test/empty/' }])[0]!.writable, undefined);
});

test('Native tsdav discovery parses DAV privilege XML and keeps unavailable permission properties unknown', async () => {
  const { fetchCalendars } = await import('tsdav');
  const requests: { path: string; body: string }[] = [];
  const origin = 'https://calendar.test';
  const properties = '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'
    + '<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>';
  const response = (path: string, name: string, permission: string, permissionStatus = 200) =>
    `<d:response><d:href>${path}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname>${properties}</d:prop>`
    + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat>'
    + `<d:propstat><d:prop><d:current-user-privilege-set>${permission}</d:current-user-privilege-set></d:prop>`
    + `<d:status>HTTP/1.1 ${permissionStatus} ${permissionStatus === 200 ? 'OK' : 'Not Found'}</d:status></d:propstat></d:response>`;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, 'PROPFIND');
    const path = new URL(String(input)).pathname;
    requests.push({ path, body: String(init?.body ?? '') });
    const rows = path === '/calendars/'
      ? response('/calendars/read/', 'Занятия', '<d:privilege><d:read/></d:privilege>')
        + response('/calendars/write/', 'Дедлайны', '<d:privilege><d:all/></d:privilege>')
        + response('/calendars/unknown/', 'Неизвестно', '', 404)
      : `<d:response><d:href>${path}</d:href><d:propstat><d:prop><d:supported-report-set/></d:prop>`
        + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
    return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</d:multistatus>`, {
      status: 207, headers: { 'content-type': 'application/xml' },
    });
  };

  const choices = await discoverCalDAVCalendars({
    fetchCalendars: options => fetchCalendars({
      ...options,
      account: { accountType: 'caldav', serverUrl: origin, rootUrl: origin, homeUrl: origin + '/calendars/' },
      fetch,
    }),
  });
  assert.match(requests[0]!.body, /current-user-privilege-set/);
  assert.deepEqual(choices.map(choice => choice.writable), [false, true, undefined]);
});

test('Mail discovery filters non-source folders and logs out after reading metadata', async () => {
  const calls: string[] = [];
  const choices = await mailFolderChoices({
    usable: true,
    async connect() { calls.push('connect'); },
    async list() {
      calls.push('list');
      return [
        { path: 'INBOX', specialUse: '\\Inbox' },
        { path: 'Курсы' },
        { path: 'Спам', specialUse: '\\Junk' },
        { path: 'Черновики', specialUse: '\\Drafts' },
        { path: 'Корзина', specialUse: '\\Trash' },
      ];
    },
    async logout() { calls.push('logout'); },
    close() { calls.push('close'); },
  });
  assert.deepEqual(choices.map(choice => choice.id), ['INBOX', 'Курсы']);
  assert.deepEqual(calls, ['connect', 'list', 'logout']);
});

test('Mail discovery closes a failed login and a failed logout without losing the original discovery error', async () => {
  const failure = new Error('authentication failed');
  let closed = 0;
  await assert.rejects(mailFolderChoices({
    usable: false,
    async connect() { throw failure; },
    async list() { throw new Error('must not list'); },
    async logout() { throw new Error('must not logout'); },
    close() { closed += 1; },
  }), error => error === failure);
  assert.equal(closed, 1);

  const choices = await mailFolderChoices({
    usable: true,
    async connect() {},
    async list() { return [{ path: 'INBOX' }]; },
    async logout() { throw new Error('socket closed'); },
    close() { closed += 1; },
  });
  assert.equal(closed, 2);
  assert.equal(choices[0]!.id, 'INBOX');
});
