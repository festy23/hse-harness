# Обнаружение CalDAV

## Метод

Исходящие DAV discovery-запросы `createDAVClient`, затем `PROPFIND {account.homeUrl}`, Depth: 1, через `fetchCalendars`. Список ресурсов читать через [REPORT](caldav-report.md); изменение — [PUT](caldav-put.md), [DELETE](caldav-delete.md).

## Описание

Авторизация и выбор существующей календарной коллекции.

## Ресурсы

[Настройки](../settings.md), `tsdav` из lockfile, [ICloudAccount](../../../../src/calendar/providers/icloud.ts), [YandexAccount](../../../../src/calendar/providers/yandex.ts).

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| serverUrl | URL | path | Да | iCloud: https://caldav.icloud.com; Yandex: https://caldav.yandex.ru |
| Authorization | Basic | header | Да | username/app-password выбранного провайдера; формирует tsdav |
| Depth | string | header | Для fetchCalendars | 1 |
| props | XML | body | Для fetchCalendars | calendar-description, calendar-timezone, displayname, calendar-color, getctag, resourcetype, supported-calendar-component-set, sync-token |
| id | URL | Локальный аргумент | Для collection | URL выбранного календаря с завершающим / |

## Выходные параметры

`calendars(ctx)` должен вернуть DAVCalendar[] из tsdav. `collection(id,ctx)` должен вернуть CalDAVCollection(client,matchedCalendar,`${provider}:${normalizedUrl}`).

## Результат в случае успеха

DAV 207/прочий успешный ответ, принятый tsdav. Выбирать только календарь с нормализованным URL, точно равным id; отсутствие должно завершить ошибкой.

## Результат в случае ошибки

Не кэшировать неоткрытую коллекцию. Отклонить Promise; store не изменять.

## Алгоритм работы

1. Для collection проверить URL и завершающий /. iCloud должен разрешать HTTPS host caldav.icloud.com либо `[a-z0-9-]+-caldav.icloud.com`; Yandex — только HTTPS caldav.yandex.ru. Запретить username/password/port/query/hash. Проверку применять также к каждому redirected URL.
2. В connect operation 120000 ms вызвать createDAVClient с serverUrl, credentials, authMethod=Basic, defaultAccountType=caldav, provider fetch. Пока discovery не закончено, запрос без своего signal должен получить ctx.signal; после создания клиента этот fallback удалить.
3. Вызвать client.fetchCalendars({fetchOptions:{signal:op.signal}}); tsdav должен выполнить discovery свойств и supported-report-set. calendars возвращает список; collection ищет точный нормализованный URL и создаёт коллекцию.
4. Каждый provider fetch должен выполнить до 5 fetch-попыток с redirect=manual. Signal объединяет timeout 30000 ms и переданный signal. Для 300..399 вычислить Location относительно текущего URL (отсутствующий Location означает ''), проверить URL, отменить body и перейти к следующей попытке. После пятой без окончательного ответа завершить redirect-limit.
5. Для status>=400, кроме 404, отменить body и выбросить provider-http. Для остальных вернуть limitedResponse с 8 MiB лимитом. Автоматического повтора 5xx/429/сетевой ошибки нет; серия попыток относится только к redirects.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| url | Нет | Нужен HTTPS URL календаря … / URL календаря должен заканчиваться / | URL не разрешён |
| missing | 2xx/207 | Выбранный календарь не найден; повторите выбор календаря | Нет точного URL |
| provider-http | >=400 кроме 404 | iCloud CalDAV: HTTP N / Яндекс CalDAV: HTTP N | HTTP отказ; wrapper не добавляет status к Error |
| redirect-limit | 3xx | Слишком много перенаправлений … | Исчерпаны 5 попыток |
| dependency | Нет/2xx/207 | Из tsdav/fetch/limitedResponse | DAV, таймаут, payload-limit |
