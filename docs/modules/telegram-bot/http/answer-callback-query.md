# answerCallbackQuery

## Метод

POST `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/answerCallbackQuery`. Внешний исходящий метод.

## Описание

Завершить индикатор ожидания callback.

## Ресурсы

[Transport](../operations/transport.md), [настройки](../settings.md), Telegram Bot API.

## Входные параметры

| Название | Расположение | Тип | Обязательность | Правило формирования |
|---|---|---|---|---|
| callback_query_id | body | string | Да | Входной id callback query |
| Content-Type | header | string | Да | application/json |

## Выходные параметры

Удалённый result (обычно true); дополнительных проверок/использования результата нет.

## Результат в случае успеха

HTTP 200 с ok=true и result; локально допускается любой response.ok при выполнении [проверок transport](../operations/transport.md).

## Результат в случае ошибки

Отклонить Promise ошибкой transport; самостоятельно не повторять запрос.

## Алгоритм работы

1. Сформировать все поля запроса по таблице; остальные параметры Telegram опустить.
2. Выполнить [call](../operations/transport.md) с методом `answerCallbackQuery` и внешним signal при наличии. Timeout 40000 ms; cooldown проверяется до сети.
3. Вернуть result вызывающему; при ошибке завершить текущую попытку и передать её вызывающему.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| BotApiRejection | Provider status / локальный 429 | Description провайдера или cooldown | Применить сохранение retry_after из transport |
| transport / protocol | Нет | Ошибка transport | Включает timeout, abort, JSON, некорректный результат |

## Протокол

[Официальный answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery).
