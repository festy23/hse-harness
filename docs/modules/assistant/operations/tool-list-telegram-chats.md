# list_telegram_chats

## Метод

Pi tool `list_telegram_chats`; [общая оболочка](tools.md).

## Описание

Список подключённых источников Telegram.

## Ресурсы

[TelegramSource](../../sources/README.md), config.chats, peers, state.cursors.

## Входные параметры

Пустой объект `{}`; иных параметров схема не задаёт.

## Выходные параметры

| Поле элемента результата | Источник или правило формирования |
|---|---|
| id/title | Поля config.chats |
| allowQuestions | chat.allowQuestions!==false |
| connected | Boolean(client && client.connected!==false && peers.has(chat.id)) |
| historyLoaded | Boolean(cursors[`tgHistory:${chat.id}`]) |

## Результат в случае успеха

Вернуть результат в [общей JSON text оболочке](tools.md).

## Результат в случае ошибки

Отклонить execute Promise; завершённые внешние/локальные действия не откатывать.

## Алгоритм работы

1. Вызвать telegram.listChats().
2. Вернуть массив в порядке config.chats без сетевого подключения. historyLoaded не означает завершение анализа queued источников моделью.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| dependency | exception | Из wrapper | Отмена/бюджет |
