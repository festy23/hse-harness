# Удаление CalDAV

## Метод

`DELETE {resource.url}` через deleteCalendarObject.

## Описание

Удаление события обязательства.

## Ресурсы

[REPORT/resolve](caldav-report.md), [транспорт](caldav-discovery.md).

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| resource.url | URL | path | Да | resolve(id) |
| Authorization | Basic | header | Да | Клиент провайдера |
| If-Match | string | header | Да для запроса | ETag из REPORT, передаёт tsdav |

## Выходные параметры

void.

## Результат в случае успеха

HTTP 2xx или 404; отсутствие ресурса при REPORT также должно завершать успешно без DELETE.

## Результат в случае ошибки

Не повторять DELETE; ошибка должна отклонять Promise.

## Алгоритм работы

1. В operation 90000 ms разрешить id, прочитать полный список и найти URL.
2. Отсутствующий ресурс завершить успешно. При отсутствии ETag завершить etag.
3. Вызвать deleteCalendarObject({calendarObject:existing,fetchOptions:{signal:op.signal}}).
4. При 404 отменить body и вернуть void. Для прочего ответа отменить body, потребовать 2xx; non-2xx завершить http. Ошибка wrapper должна пробрасываться непосредственно.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| etag | До DELETE | CalDAV не вернул ETag; безопасное удаление невозможно | Нет ETag |
| http | non-2xx кроме 404 | CalDAV: HTTP N | status приложен checked |
| dependency | Разный | Из transport/resolve | Сеть, scope, отмена |
