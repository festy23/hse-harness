# Чтение события Google

## Метод

`GET /calendars/{calendarId}/events/{eventId}`.

## Описание

Чтение события Google.

## Ресурсы

[Google transport](google-request.md), [Google event mapping](../operations/google-mapping.md).

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| calendarId | string | path | Да | encodeURIComponent выбранного id |
| eventId | string | path | Да | encodeURIComponent event.id/входного id |

## Выходные параметры

CalendarEvent; все поля по decode.

## Результат в случае успеха

HTTP 2xx с JSON события.

## Результат в случае ошибки

Пробросить ошибку [транспорта](google-request.md), кроме явно заданных ветвей алгоритма. Локальный Store этим методом не изменяется.

## Алгоритм работы

1. Сформировать путь из выбранного calendarId и id; вызвать request GET без body.
2. Применить decode и вернуть событие. Повтор не выполнять.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| dependency | non-2xx/2xx | Из transport/decode | Включая 404 и неверные метаданные |
