# Перенос события Google

## Метод

`PATCH /calendars/{calendarId}/events/{eventId}`.

## Описание

Перенос события Google.

## Ресурсы

[Google transport](google-request.md), [Google event mapping](../operations/google-mapping.md).

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| calendarId | string | path | Да | encodeURIComponent выбранного id |
| eventId | string | path | Да | encodeURIComponent event.id/входного id |
| start.dateTime/end.dateTime | string | body | Да | Входные start/end |
| start.timeZone/end.timeZone | string | body | Да | Europe/Moscow |

## Выходные параметры

Ответ API не используется.

## Результат в случае успеха

HTTP 2xx; void.

## Результат в случае ошибки

Пробросить ошибку [транспорта](google-request.md), кроме явно заданных ветвей алгоритма. Локальный Store этим методом не изменяется.

## Алгоритм работы

1. Вызвать request PATCH с указанными границами; не отправлять title, description, recurrence или metadata.
2. Вернуть исход запроса. Собственного повторного GET, If-Match и retry метод не выполняет; контроль одобрения находится в Study.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| dependency | non-2xx/2xx | Из transport | Неизвестный исход записи передаётся approvals |
