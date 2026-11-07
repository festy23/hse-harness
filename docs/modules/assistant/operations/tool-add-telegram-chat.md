# add_telegram_chat

## Метод

Pi tool `add_telegram_chat`; [общая оболочка](tools.md).

## Описание

Подключение учебного чата без перезапуска.

## Ресурсы

[Telegram addChat](../../sources/README.md), конфигурационный файл, peers, history cursor.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| reference | string | Да | 1..500 символов; t.me, @username или ID |

## Выходные параметры

| Поле результата | Источник или правило формирования |
|---|---|
| id/title | Сохранённый канонический chat |
| allowQuestions | saved.allowQuestions!==false |
| alreadyAdded | config.chats содержал chat.id до записи |
| historyFrom | 2026-09-01T00:00:00+03:00 |
| backfillPending | !state.cursors[`tgHistory:${saved.id}`] |

## Результат в случае успеха

Вернуть результат в [общей JSON text оболочке](tools.md).

## Результат в случае ошибки

Отклонить execute Promise; завершённые внешние/локальные действия не откатывать.

## Алгоритм работы

1. Передать reference и ctx в telegram.addChat; method должен подключить MTProto, разрешить только доступный допустимый chat и сохранить его по [Sources](../../sources/README.md).
2. Возвратить результат без преобразования. История должна попадать в очередь последующим source poll; не считать backfillPending=false подтверждением анализа всей очереди.
3. Не запрашивать ownerTurn в wrapper. Правила учебной релевантности задаёт system prompt; членство/тип чата и read-only статус обеспечивает Sources.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| dependency | exception | Из Telegram addChat | Неверный reference, доступ/тип, запись config, транспорт |
