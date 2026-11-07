# Удаление события Google

## Метод

`DELETE /calendars/{calendarId}/events/{eventId}`.

## Описание

Удаление события Google.

## Ресурсы

[Google transport](google-request.md), [Google event mapping](../operations/google-mapping.md).

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| calendarId | string | path | Да | encodeURIComponent выбранного id |
| eventId | string | path | Да | encodeURIComponent event.id/входного id |

## Выходные параметры

Ответ API не используется.

## Результат в случае успеха

HTTP 2xx, либо отсутствие события (404/410); void.

## Результат в случае ошибки

Пробросить ошибку [транспорта](google-request.md), кроме явно заданных ветвей алгоритма. Локальный Store этим методом не изменяется.

## Алгоритм работы

1. Отправить DELETE без body.
2. Успех и ошибки status=404/410 завершить успешно. Прочие ошибки пробросить; повтор не выполнять.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| dependency | non-2xx кроме 404/410 | Из transport | Ошибка удаления |
