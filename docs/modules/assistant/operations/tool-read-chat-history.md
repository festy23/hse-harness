# read_chat_history

## Метод

Pi tool `read_chat_history`; [общая оболочка](tools.md).

## Описание

Немедленное чтение контекста подключённого чата.

## Ресурсы

[Telegram history/source mapping](../../sources/README.md).

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| chat | string | Да | Канонический ID |
| limit | integer | Да | 1..100 |

## Выходные параметры

Source[] из history, с исходными author/replyTo там, где доступны; поля Source определены Core.

## Результат в случае успеха

Вернуть результат в [общей JSON text оболочке](tools.md).

## Результат в случае ошибки

Отклонить execute Promise; завершённые внешние/локальные действия не откатывать.

## Алгоритм работы

1. Вызвать telegram.history(chat,limit,ctx). Sources должен подключиться, потребовать peers.has(chat), запросить первую history page offset=0 с пределом 1..100.
2. Вернуть только Api.Message с непустым message после source mapping в порядке страницы. Инструмент не должен сам ставить этот ответ в очередь или отмечать history cursor.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| forbidden | exception | Чат не разрешен | Нет подключённого peer |
| dependency | exception | Из Telegram | Сеть, mapping, отмена |
