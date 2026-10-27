# Вызов HTTP Bot API

## Метод

`TelegramBot.call<T>(method,args,signal?) → Promise<T>`; raw POST JSON к Telegram. botIdentity(token) возвращает `telegram:` и нормализованный BigInt числовой префикс `/^(\d{1,20}):/`; при отсутствии префикса — `telegram:opaque:` и первые 24 hex SHA-256 токена. Getter identity возвращает undefined при отсутствующей/пустой env.

## Ресурсы

[Настройки](../settings.md), [cooldown](../database/README.md), fetch, внешний AbortSignal.

## Входные и выходные параметры

| Поле | Тип | Обязательность | Правило |
|---|---|---|---|
| method | string | Да | Суффикс URL, отдельной allowlist в call нет |
| args | unknown | Да | JSON.stringify в body |
| signal | AbortSignal | Нет | Прерывает fetch совместно с timeout |
| result | T | Да при успехе | Значение JSON.result, кроме sendMessage глубокой проверки нет |

## Алгоритм работы

1. Вычислить max локального retryAt и `Store.state.botRetryAt ?? 0`. Если значение > Date.now(), завершить BotApiRejection с code 429, текстом `Telegram Bot API: flood control cooldown`, retryAfter=ceil((retryAt-now)/1000), без сети.
2. Прочитать secret TELEGRAM_BOT_TOKEN. Выполнить POST `https://api.telegram.org/bot<token>/<method>`, header content-type application/json, body JSON.stringify(args), signal=timeout(40000) либо any([входной signal,timeout]). Внутреннего HTTP retry нет.
3. Прочитать response.json() как unknown. Требовать object и boolean ok; иначе ошибка invalid response.
4. Если ok=false, вычислить code из числового error_code либо HTTP status; прочитать parameters.retry_after только из object parameters.
   1. Для положительного safe integer retry_after вычислить until=Date.now()+retry_after*1000. Если until не safe integer, завершить invalid retry delay.
   2. Иначе присвоить локальному retryAt максимум с until; при Store присвоить botRetryAt максимум старого и until и дождаться save.
   3. Завершить BotApiRejection с prefix `Telegram Bot API: ` и string description либо code. retryAfter передать для любого числового retry_after, даже если cooldown не сохранялся.
5. При ok=true требовать response.ok и наличие собственного/доступного поля result; иначе invalid success response.
6. Только для method=sendMessage требовать object result и положительный safe integer message_id; иначе missing message receipt.
7. Вернуть result. Ошибка чтения JSON, сети, secret или save завершает вызов без внутреннего повтора.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| BotApiRejection | HTTP code либо локальный 429 | Provider description / flood control cooldown | source='provider', code и retryAfter доступны вызывающему |
| Error | Нет локального HTTP ответа | invalid response / invalid retry delay / invalid success response / missing message receipt | Нарушение контракта ответа |
| dependency | Нет | Ошибка fetch, JSON, secret, Store | Передать без маскировки адаптером |

## Результат в случае успеха

Вернуть результат удалённого метода после локальной проверки, без дополнительных записей кроме cooldown ветви ошибки.

## Результат в случае ошибки

Отклонить Promise. Ошибка после удалённого эффекта не доказывает отсутствие эффекта. Применять [журнал доставки](send.md) для sendMessage.
