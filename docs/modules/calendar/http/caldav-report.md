# Чтение ресурсов CalDAV

## Метод

`REPORT {calendar.url}`: calendar-query, затем calendar-multiget через tsdav.fetchCalendarObjects.

## Описание

Получение полного содержимого VEVENT и ETag выбранной коллекции.

## Ресурсы

[Транспорт](caldav-discovery.md), [iCalendar compute](../operations/icalendar.md), CalDAVCollection.

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| calendar.url | URL | path | Да | Выбранная коллекция |
| Authorization | Basic | header | Да | Credentials клиента |
| Depth | string | header | Да | 1 |
| calendar-query | XML | body | Первый запрос | Filter VCALENDAR/VEVENT, prop getetag; диапазон на сервер не передаётся |
| calendar-multiget | XML | body | При непустом списке href | prop getetag/calendar-data, отфильтрованные href первого ответа |
| signal | AbortSignal | Локальный транспорт | Да | op.signal |

## Выходные параметры

DAVCalendarObject[] `{url,etag?,data}` из tsdav. На уровне коллекции list/range возвращают CalendarEvent[], get — CalendarEvent, changes — `{events:await list(),full:true}` без cursor.

## Результат в случае успеха

HTTP 207 с DAV properties, принятыми tsdav. Ресурсы без расширения .ics должны допускаться.

## Результат в случае ошибки

Пробросить transport/parse/compute ошибку; частичный список не возвращать.

## Алгоритм работы

1. Начать operation 120000 ms. Получить все calendar objects; `resource(url)` также должен читать полный список, затем искать точное равенство нормализованного URL.
2. Фильтр href должен допускать тот же origin, pathname с prefix base.pathname, отличный от base.pathname и не заканчивающийся `/`, без query/hash/username/password. Невалидный href пропускать. Пустой список должен дать [] без multiget.
3. Для list/range последовательно передать каждый объект в compute: type=calendar, action=list либо range при truthy from, data=requiredString(object.data), url=normalized URL, from/to как вход. Проверять abort перед каждым. Общая длина >20000 должна завершить payload-limit. Отсортировать по Date(start) по возрастанию и вернуть.
4. Для get сначала разрешить id по правилу ниже, найти resource. При отсутствии завершить missing; иначе compute action=get с target ResourceId и data. Вернуть результат. Для changes игнорировать cursor и вернуть полный list с full=true.

### Разрешение ID

`ics.` должен декодироваться как base64url JSON object `{url,recurrenceId?}` с обязательными непустыми строками. Иной id должен давать URL `encodeURIComponent(id)+'.ics'` относительно calendar.url. URL должен иметь тот же origin, pathname prefix base.pathname, без query/hash/user/password. recurrenceId при наличии должен быть конечной датой JS Date. Нарушение должно завершать операцию до запроса мутации.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| missing | 207 | CalDAV: событие не найдено | Нет точного ресурса |
| scope | Нет | Событие вне выбранного календаря | ID не принадлежит коллекции |
| recurrence | Нет | Некорректный recurrence id | Невалидная дата |
| payload-limit | 207 | Слишком много событий календаря | >20000 |
| dependency | Разный | Из transport/compute/validation | Чтение или декодирование |
