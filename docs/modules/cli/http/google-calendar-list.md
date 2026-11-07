# Выбор Google-календарей

## Метод

Внешний `GET https://www.googleapis.com/calendar/v3/users/me/calendarList` через Google.request.

## Описание

Перечислить календари, доступные для чтения, и различить право записи.

## Ресурсы

[Google transport](../../calendar/README.md), [connection](../operations/connections.md), OperationContext calendarScan.

## Входные параметры

| Название | Тип | Обязательность | Расположение | Правило |
|---|---|---|---|---|
| maxResults | string | да | query | '250' |
| pageToken | string | после первой страницы | query | предыдущий nextPageToken |
| Authorization | bearer | адаптер | header | Google.request из сохранённого OAuth |

Body отсутствует. Timeout/refresh/errors Google.request определяются [Calendar](../../calendar/README.md); все страницы должны разделять operation calendarScan.

## Выходные параметры

Choice[]: id=calendar.id, label=calendar.summary||'Календарь без названия', writable=(accessRole owner/writer), hint=чтение и запись либо только чтение. ID deduplicate с последним значением и позицией первого появления.

## Результат в случае успеха

HTTP2xx для каждой страницы; вернуть map values после отсутствующего/пустого nextPageToken.

## Результат в случае ошибки

Невалидный items/pageToken или повтор token должны завершать SetupIssue. Повтор страницы без продвижения запрещён; отдельный retry discovery отсутствует.

## Алгоритм работы

1. Создать Map calendars, Set visited, pageToken undefined. GET users/me/calendarList с URLSearchParams(maxResults250,pageToken при наличии).
2. items undefined→[]; иной не-array — DATA. Пропускать entry без непустого string id либо accessRole вне owner/writer/reader. Для остальных set Map по mapping выхода.
3. nextPageToken если присутствует обязан быть string; пустой→undefined. При непустом token уже в visited — PAGE; иначе добавить. Повторять шаг1, пока token непустой.
4. Вернуть [...Map.values()] без дополнительной сортировки. Выбор отдельных ролей и запрет одного calendar для обеих ролей применяет [sections](../operations/sections.md).

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| HTTP | статус Google adapter | Google error | Transport контракт Calendar |
| DATA | локальный | Google Calendar вернул некорректный список/страницу… | Shape |
| PAGE | локальный | Google Calendar повторяет страницу списка… | Цикл pagination |
| CANCEL | локальный | Настройка отменена | Task parent abort |
