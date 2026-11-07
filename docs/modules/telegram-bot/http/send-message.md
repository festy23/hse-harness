# sendMessage

## Метод

POST `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage`. Внешний исходящий метод.

## Описание

Доставить одну текстовую часть владельцу.

## Ресурсы

[Transport](../operations/transport.md), [настройки](../settings.md), Telegram Bot API.

## Входные параметры

| Название | Расположение | Тип | Обязательность | Правило формирования |
|---|---|---|---|---|
| chat_id | body | number | Да | TelegramBot.owner |
| text | body | string | Да | Текущая часть и префикс неопределённого повтора при необходимости |
| link_preview_options | body | object | Да | {is_disabled:true} |
| reply_markup | body | object | Нет | Только последняя часть при наличии buttons: {inline_keyboard:buttons} |
| Content-Type | header | string | Да | application/json |

## Выходные параметры

Message; использовать только message_id: положительный safe integer. parse_mode и entities не передавать. Buttons — массив строк массива {text:string,callback_data:string}; отдельной проверки размера callback_data в адаптере нет.

## Результат в случае успеха

HTTP 200 с ok=true и result; локально допускается любой response.ok при выполнении [проверок transport](../operations/transport.md).

## Результат в случае ошибки

Отклонить Promise ошибкой transport; самостоятельно не повторять запрос.

## Алгоритм работы

1. Сформировать все поля запроса по таблице; остальные параметры Telegram опустить.
2. Выполнить [call](../operations/transport.md) с методом `sendMessage` и внешним signal при наличии. Timeout 40000 ms; cooldown проверяется до сети.
3. Вернуть result вызывающему; при ошибке завершить текущую попытку и передать её вызывающему.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| BotApiRejection | Provider status / локальный 429 | Description провайдера или cooldown | Применить сохранение retry_after из transport |
| transport / protocol | Нет | Ошибка transport | Включает timeout, abort, JSON, некорректный результат |

## Протокол

[Официальный sendMessage](https://core.telegram.org/bots/api#sendmessage).
