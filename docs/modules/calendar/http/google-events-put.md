# Обновление события Google

## Метод

`PUT /calendars/{calendarId}/events/{eventId}`.

## Описание

Обновление события Google.

## Ресурсы

[Google transport](google-request.md), [Google event mapping](../operations/google-mapping.md).

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| calendarId | string | path | Да | encodeURIComponent выбранного id |
| eventId | string | path | Да | encodeURIComponent event.id/входного id |
| body | GoogleEvent | body | Да | encode(event) |

## Выходные параметры

Ответ API не используется.

## Результат в случае успеха

HTTP 2xx; void.

## Результат в случае ошибки

Пробросить ошибку [транспорта](google-request.md), кроме явно заданных ветвей алгоритма. Локальный Store этим методом не изменяется.

## Алгоритм работы

1. В tool operation 90000 ms вычислить body=encode(event), path по event.id. Отправить PUT без If-Match.
2. При успехе завершить. При ошибке со status!=404 пробросить её. При 404 выполнить [POST](google-events-post.md) с тем же body.
3. При успехе POST завершить. Если POST завершился 409, один раз повторить PUT с тем же body; его любой исход вернуть вызывающему. Другую ошибку POST пробросить.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| dependency | non-2xx/2xx | Из transport/encode | После разрешённой последовательности PUT/POST/PUT |
