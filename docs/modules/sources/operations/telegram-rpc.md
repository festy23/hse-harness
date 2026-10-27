# MTProto RPC transport

## Метод

telegramInvoke(client,request,ctx?) → request.__response. Использовать MTProto через teleproto, не HTTP Bot API.

## Ресурсы

[Кэши floodWaits](../caches.md), [Core OperationContext](../../core/README.md), TelegramClient.invoke.

## Алгоритм работы

1. Создать withOperation(request,budgets.rpc=30000,ctx). Найти until=floodWaits.get(client)?.get(request.className)??0. Если until>performance.now(), завершить rate-limit с retryAfterMs=ceil(until-now), не отправляя RPC.
2. Вызвать client.invoke(request,undefined,options).

   | Поле options | Формирование |
   |---|---|
   | abortSignal | op.signal |
   | timeout | max(1,ceil(op.remainingMs())) ms |
   | maxRetryCount | 2 |
   | floodSleepThreshold | 0 |
3. Вернуть типизированный ответ без дополнительного общего парсинга; конкретные типы проверяют вызывающие операции.
4. При ошибке сначала op.throwIfAborted; существующий OperationError передать неизменным. Если error.code=401, завершить authentication `Telegram: повторите подключение аккаунта`; при 403 — permission `Telegram: нет доступа к чату`.
5. Иначе если error.seconds — конечное число >=0, вычислить retryAfterMs=min(seconds,86400)*1000, записать floodWaits для client и request.className до performance.now()+retryAfterMs, завершить rate-limit `Telegram: временное ограничение запросов` с retryAfterMs. Внутри этого слоя sleep не выполнять.
6. Все другие ошибки передать вызывающему; самостоятельного цикла retry поверх teleproto invoke нет.

## Ошибки

| Код | Message | Результат |
|---|---|---|
| rate-limit | Telegram: временное ограничение запросов | Только этот класс request и client ограничен до monotonic until |
| authentication/permission | Сообщения шага 4 | Не повторять в текущей операции |
| deadline/cancelled | op.signal.reason | Отмена передаётся SDK |
| external | Исходная ошибка invoke | Передать вызывающему |

Указанный maxRetryCount — параметр teleproto. Гарантию количества доставленных side effects из него не выводить; SendMessage использует предоставленный randomId.
