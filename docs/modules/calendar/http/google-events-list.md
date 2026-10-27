# Список и изменения Google

## Метод

`GET /calendars/{calendarId}/events`.

## Описание

Список и изменения Google.

## Ресурсы

[Google transport](google-request.md), [Google event mapping](../operations/google-mapping.md).

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| calendarId | string | path | Да | encodeURIComponent выбранного id |
| maxResults | string | query | Да | 2500 |
| pageToken | string | query | Нет | nextPageToken предыдущей страницы |
| timeMin/timeMax | string | query | Только range | from/to |
| singleEvents/orderBy | string | query | Только range | true/startTime |
| showDeleted | string | query | Только changes | true |
| syncToken | string | query | При truthy cursor в changes | Сохранённый token |

## Выходные параметры

| Поле ответа | Использование |
|---|---|
| items? | decode каждого; отсутствие означает [] |
| nextPageToken? | Следующая страница |
| nextSyncToken? | cursor последней страницы changes |

## Результат в случае успеха

HTTP 2xx; list/range возвращают массив, changes возвращает `{events,cursor,full:!token}`.

## Результат в случае ошибки

Пробросить ошибку [транспорта](google-request.md), кроме явно заданных ветвей алгоритма. Локальный Store этим методом не изменяется.

## Алгоритм работы

1. Открыть source operation 120000 ms. Начать events=[], page=undefined, pages=Set; для changes token=cursor и retried=false.
2. Выполнить GET с query таблицы; список без range/changes передаёт только maxResults/pageToken.
3. Для changes и HTTP 410 при retried=false сбросить token/page/events/pages, установить retried=true и начать шаг 2 без syncToken. Иные ошибки пробросить.
4. Добавить decoded items в порядке ответа. Если nextPageToken уже содержится в pages, завершить protocol; иначе добавить token в pages. Если events.length>20000 завершить payload-limit. При page перейти к шагу 2.
5. Для list/range вернуть events без дополнительной сортировки; для changes вернуть поля результата с cursor=nextSyncToken. Никаких Store-записей внутри метода не выполнять.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| protocol | 2xx | Календарь повторил страницу | Повтор token |
| payload-limit | 2xx | Слишком много событий календаря | >20000 |
| dependency | non-2xx/2xx | Из transport/decode | Включая повторный 410 |
