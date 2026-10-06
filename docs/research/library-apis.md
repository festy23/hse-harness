# Конкретные API библиотек

Проверено 4 октября 2026 года по документации владельцев и исходникам опубликованных npm-пакетов. Пакеты для исследования скачаны/прочитаны в `/tmp/hse-library-api-research`, без установки и запуска интеграций. Примеры ниже — справочные фрагменты с условными `client`, `peer`, `handle`, `saveCheckpoint`; они не реализуют сервис и не проверены с учетными данными.

| Пакет | Проверенная версия | Результат |
|---|---|---|
| `telegram` / GramJS | `2.26.22` | API работает, но `catchUp()` — TODO; родитель сообщил deprecation при установке. |
| `teleproto` | npm `latest` = **`1.229.1`** | Есть gap/difference/reconnect recovery; сохранение update counters после нового процесса требует кода сервиса. |
| `imapflow` | `2.2.4` | Чтение папок, MIME-структуры и UID-checkpoint поддерживается. |
| `googleapis` | `183.0.0` | Типизированные Calendar REST-вызовы и OAuth2. |

## Telegram: teleproto вместо GramJS

Переход сохраняет `TelegramClient`, `iterMessages`, `invoke(new Api...)`, builders событий; меняется имя imports. В **обоих** проверенных пакетах TL `long` — **`BigInteger` из `big-integer`**, не нативный `bigint`. ID и `randomId` сериализуются десятичными строками, при вызове восстанавливаются через `bigInt(string)`; приведение 64-битных значений к `number` неверно. [Миграция](https://docs.teleproto.dev/migrating-from-gramjs), [опубликованные типы teleproto 1.229.1](https://unpkg.com/teleproto@1.229.1/tl/generated/api.d.ts), [GramJS 2.26.22](https://unpkg.com/telegram@2.26.22/tl/api.d.ts).

```ts
import { Api } from 'teleproto';
import { Raw } from 'teleproto/events';
import * as utils from 'teleproto/Utils';
import bigInt from 'big-integer';

const cutoffSeconds = Date.parse('2026-09-01T00:00:00+03:00') / 1000;
for await (const message of client.iterMessages(peer, { limit: undefined })) {
  if (message.date < cutoffSeconds) break;
  // message.message — исходный текст, date — Unix seconds, id — number.
  await handle(message);
}

client.addEventHandler(async (update: Api.TypeUpdate) => {
  if (update instanceof Api.UpdateNewMessage ||
      update instanceof Api.UpdateNewChannelMessage ||
      update instanceof Api.UpdateEditMessage ||
      update instanceof Api.UpdateEditChannelMessage) {
    const message = update.message;
    if (message instanceof Api.Message) {
      const chatId = utils.getPeerId(message.peerId); // marked decimal string
      await handle({ chatId, message });
    }
  } else if (update instanceof Api.UpdateDeleteChannelMessages) {
    await handle({ channelId: update.channelId.toString(), ids: update.messages });
  } else if (update instanceof Api.UpdateDeleteMessages) {
    // Здесь нет chatId: связь должна находиться по ранее сохраненным сообщениям.
    await handle({ ids: update.messages });
  }
}, new Raw({}));

// Вызывается исключительно после сервисной проверки одобрения конкретного draft.
const result = await client.invoke(new Api.messages.SendMessage({
  peer: await client.getInputEntity(approvedDraft.chatId),
  message: approvedDraft.text,
  randomId: bigInt(approvedDraft.randomId),
  replyTo: approvedDraft.replyToId
    ? new Api.InputReplyToMessage({ replyToMsgId: approvedDraft.replyToId })
    : undefined,
}));
```

`iterMessages` по умолчанию идет от новых к старым; `offsetDate` в этом режиме — исключительная верхняя граница. `search`/`filter`/`fromUser` меняют историю на Search. `getMessages` без лимита может вернуть только одно сообщение; для полного обхода использовать iterator и остановку по дате. `invoke(SendMessage)` возвращает `Api.TypeUpdates`, **не** объект Message; идентификатор отправки ищется в `UpdateShortSentMessage`, `UpdateMessageID`/новом сообщении. Для повтора после неизвестного сетевого результата сохраняется тот же `randomId`. [messages.js, точная версия](https://unpkg.com/teleproto@1.229.1/client/messages.js), [API типов](https://unpkg.com/teleproto@1.229.1/tl/generated/api.d.ts).

### Восстановление после офлайна — существенная граница

В `teleproto@1.229.1` реализованы common `GetDifference` и channel `GetChannelDifference`; `otherUpdates` передаются обработчикам, включая edit/delete. Reconnect существующего клиента вызывает catchUp. Но manager хранит common state и channel trackers в памяти. При первом catchUp без state он запрашивает **текущее** GetState. `DifferenceTooLong`/`ChannelDifferenceTooLong` не восстанавливают весь потерянный поток. [UpdateManager, commit npm-релиза](https://github.com/sanyok12345/teleproto/blob/7a0f462aa2b26034bacfe030c8e75199297f72a8/teleproto/client/updates/manager.ts), [reconnect](https://unpkg.com/teleproto@1.229.1/client/TelegramClient.js).

Документация утверждает, что counters сохраняются сессией. Опубликованный код этого **не подтверждает**: `StringSession.save()` содержит DC/address/port/auth key; `StoreSession` сохраняет auth keys и entities, но не pts/qts/date/seq и per-channel pts. Поэтому сохраненная auth session + новый процесс + catchUp не являются достаточной схемой восстановления. Это проверенное расхождение документации и npm source. [Документация updates](https://docs.teleproto.dev/internals/updates), [StringSession 1.229.1](https://unpkg.com/teleproto@1.229.1/sessions/StringSession.js), [StoreSession](https://github.com/sanyok12345/teleproto/blob/7a0f462aa2b26034bacfe030c8e75199297f72a8/teleproto/sessions/StoreSession.ts).

Для common state есть public `client.updateManager.refreshFromState({ pts, qts, date, seq })`: сохраненный checkpoint нужно восстановить **до** автозапуска update loop, с контролем порядка подключения. Для групп-супергрупп нужен отдельный технический checkpoint pts и replay через raw API; считать историю новых сообщений восстановлением пропущенных edit/delete нельзя. Не использовать приватное поле manager.channels как стабильный API. [Сигнатуры manager](https://unpkg.com/teleproto@1.229.1/client/updates/manager.d.ts).

```ts
// Схема одного channel difference запроса; цикл/очередь/checkpoint — обязанности host.
const diff = await client.invoke(new Api.updates.GetChannelDifference({
  channel: inputChannel, // Api.InputChannel: channelId + accessHash
  filter: new Api.ChannelMessagesFilterEmpty(),
  pts: savedChannelPts,
  limit: 100,
  force: true,
}));
// ChannelDifference: применить newMessages + otherUpdates, затем сохранить pts;
// если !final — продолжить. Empty: сохранить pts, учитывать final.
// TooLong: пометить неполное покрытие и перепроверить доступное текущее состояние.
```

Таким образом teleproto подходит как поддерживаемый MTProto client, но гарантия process-restart recovery требует host checkpoints и проверки live/offline сценариев. Для `telegram@2.26.22` `catchUp()` вообще пустой; это отдельная причина не основывать восстановление на нем. [GramJS опубликованный updates.js](https://unpkg.com/telegram@2.26.22/client/updates.js).

## ImapFlow 2.2.4

```ts
import { ImapFlow } from 'imapflow';
const mail = new ImapFlow({
  host: 'imap.yandex.ru', port: 993, secure: true,
  auth: { user: mailboxAddress, pass: appPassword }, logger: false,
});
await mail.connect();
const lock = await mail.getMailboxLock('INBOX', { readOnly: true });
try {
  if (!mail.mailbox) throw new Error('No selected mailbox');
  const uidValidity = mail.mailbox.uidValidity.toString(); // native bigint здесь
  const ids = await mail.search({ since: new Date('2026-08-31T00:00:00Z') }, { uid: true });
  if (Array.isArray(ids) && ids.length) {
    // Для реального объема — ограниченные batches, не fetchAll всего ящика.
    const metadata = await mail.fetchAll(ids.slice(0, 50), {
      uid: true, envelope: true, internalDate: true, bodyStructure: true,
    }, { uid: true });
    for (const message of metadata) {
      // part получен обходом bodyStructure; выбирать основной text/plain,
      // исключать disposition=attachment и ветки приложенных message/rfc822.
      const part = selectMainPlainTextPart(message.bodyStructure);
      if (!part) continue;
      const download = await mail.download(String(message.uid), part, { uid: true });
      if (!download.content) continue; // DownloadNotFound — {}, а не false
      for await (const bytes of download.content) {
        await consumeTextBytes(bytes); // поток декодирован, текст преобразован в UTF-8
      }
      await saveCheckpoint({ folder: 'INBOX', uidValidity, uid: message.uid });
    }
  }
} finally { lock.release(); }
await mail.logout();
```

`bodyStructure` — дерево с `type`, `part`, `parameters.charset`, `encoding`, `disposition`, `childNodes`. Альтернатива download: `fetchOne(String(uid), { bodyParts: [part] }, { uid: true })`, результат `bodyParts: Map<string, Buffer>`; при обычном BODY запросе transfer encoding/charset еще нужно декодировать самостоятельно. `download(uid, part, { uid:true })` делает это сам. `fetch` использует PEEK. [Точные типы](https://unpkg.com/imapflow@2.2.4/dist/cjs/types.d.ts), [методы](https://unpkg.com/imapflow@2.2.4/dist/cjs/imap-flow.d.ts), [download implementation](https://unpkg.com/imapflow@2.2.4/dist/cjs/download.js), [FETCH implementation](https://unpkg.com/imapflow@2.2.4/dist/cjs/commands/fetch.js).

Нельзя вызывать другие IMAP-команды внутри `for await (mail.fetch(...))`: очередь может зависнуть. Сначала закончить metadata fetch, затем получать части. UIDVALIDITY сравнивается отдельно по папке; при смене checkpoint сбрасывается. Checkpoint продвигается после успешного сохранения каждого письма, не просто на максимальный UID полученного batch. `UID last+1:*` требует фильтра `uid > last` (обратный диапазон при отсутствии новых писем может включить старое); надежнее сначала получить точный список UID. `SINCE` сравнивает даты IMAP, поэтому пример берет небольшой запас до московской границы и точный cutoff применяется после чтения. Соединение само не переподключается. [API и ограничения очереди](https://imapflow.com/docs/api/imapflow-client/), [IMAP диапазоны/даты](https://www.rfc-editor.org/rfc/rfc9051.html).

## Google Calendar: googleapis 183.0.0

```ts
import { google } from 'googleapis';
const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
auth.setCredentials({ refresh_token: savedRefreshToken });
const calendar = google.calendar({ version: 'v3', auth });
const created = await calendar.calendars.insert({
  requestBody: { summary: 'Учебный ассистент', timeZone: 'Europe/Moscow' },
});
const agentCalendarId = created.data.id;

// Полная синхронизация: все страницы. Delta: тот же набор прочих параметров.
const page = await calendar.events.list({
  calendarId: timetableCalendarId,
  syncToken: savedSyncToken || undefined,
  pageToken: nextPageToken || undefined,
  showDeleted: true,
});
const events = page.data.items || [];
const more = page.data.nextPageToken;
// Сохранять nextSyncToken только после последней страницы и применения всех changes.
const newSyncToken = page.data.nextSyncToken;

await calendar.events.insert({ calendarId: agentCalendarId!, requestBody: eventResource });
await calendar.events.patch({
  calendarId: agentCalendarId!, eventId,
  requestBody: { summary: updatedSummary, start: updatedStart, end: updatedEnd },
});
await calendar.events.delete({ calendarId: agentCalendarId!, eventId });
```

Запросы используют `requestBody`, результаты — `response.data`; `events.patch` поддерживает частичное изменение, `update` — полную замену. REST endpoint/HTTP method задается generated client. Проверено по опубликованным [v3.d.ts](https://unpkg.com/googleapis@183.0.0/build/src/apis/calendar/v3.d.ts) и [v3.js](https://unpkg.com/googleapis@183.0.0/build/src/apis/calendar/v3.js); OAuth offline access описан [Google](https://developers.google.com/identity/protocols/oauth2/web-server#offline).

`events.list` с syncToken запрещает `timeMin/timeMax/updatedMin/orderBy/q` и дополнительные фильтры; ошибка HTTP 410 требует полной пересинхронизации **этого календаря**. Отмененные события приходят как `status: 'cancelled'`. Пагинация, recurringEventId/originalStartTime и права исходного календаря не исчезают при использовании библиотеки. Для безопасного retry создания события можно задать допустимый собственный `event.id`, сохранить его до отправки и сверить 409, вместо нового события при каждом retry. [Правила sync](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [свойства Event, включая id](https://developers.google.com/workspace/calendar/api/v3/reference/events).

Pi `1.0.2` устанавливается родителем и в этой узкой заметке не перепроверяется. Источники/сессии не подключались; наличие нужных библиотечных APIs не означает пройденные интеграционные сценарии.


## Календари: дополнение от 6 октября 2026

По запросу пользователя основной провайдер заменен на iCloud; Google сохранен за выключенным feature flag. Для реализации установлены и проверены опубликованные исходники/типы `tsdav@2.4.0`, `node-ical@0.27.3` и `ical.js@2.2.1`.

- `tsdav`: `createDAVClient` с Basic auth и собственным fetch; `fetchCalendars`, `fetchCalendarObjects`, `createCalendarObject`, `updateCalendarObject`, `deleteCalendarObject`. Обновление/удаление передают ETag, создание использует условный PUT. SDK строго проверяет DAV multistatus: multiget отсутствующего объекта с 404 вызывает ошибку. Наличие ресурса в этой версии сервиса проверяется через полный успешно прочитанный снимок, затем применяется условная запись. [Репозиторий владельца](https://github.com/natelindev/tsdav), [исходники закрепленного пакета](https://unpkg.com/tsdav@2.4.0/dist/tsdav.js).
- `node-ical`: `sync.parseICS` и `expandRecurringEvent` для RRULE/EXDATE/переносов; floating время получает Moscow TZ перед разбором, DATE сохраняет календарную дату независимо от зоны сервера. [Репозиторий владельца](https://github.com/jens-maus/node-ical).
- `ical.js`: чтение и сериализация VCALENDAR/VEVENT; перенос экземпляра сохраняет прочие свойства и серию, DATE recurrence-id остается DATE. [Документация владельца](https://kewisch.github.io/ical.js/api/).

Контракты и настоящий HTTP-путь tsdav проверены на локальном CalDAV-стенде. Авторизация и сохранение нестандартных метаданных реальным iCloud-сервером еще требуют проверки после подключения аккаунта. Apple описывает [пароли приложений](https://support.apple.com/en-us/102654) и [доступ сторонних приложений к календарям](https://support.apple.com/en-us/121539).
