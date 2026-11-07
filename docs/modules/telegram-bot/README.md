# Telegram Bot

## Назначение

Модуль принимает личные сообщения владельца, маршрутизирует команды и callbacks и доставляет ответы через HTTP Telegram Bot API. Контракт фиксирует ревизию `f3bacd3`.

## Границы ответственности

Принимать действия только от `ownerId` в его private-чате. Принимать текст и признак пересылки; содержимое пересылок передавать как данные. Сохранять owner-сообщение до продвижения polling offset. Доставлять длинные ответы последовательными частями с журналом квитанций. HTTP/gRPC сервер не предоставлять; webhook не создавать и не удалять. Учебные чаты читать через отдельный [Sources](../sources/README.md). Изменение учебных работ и подтверждения выполнять в [Study](../study/README.md); обновление установки — в [Runtime](../runtime/README.md).

## Зависимости

Использовать Node.js fetch, AbortSignal и crypto; [Core](../core/README.md) для Store, lifecycle и operation budgets; Calendar для `/tasks`; Runtime для `/updates`; Study для approve/reject. Отдельный Bot API SDK не использовать.

## Контракты

- [Состояние](database/README.md), [кэши](caches.md), [настройки](settings.md).
- [HTTP transport](operations/transport.md), [getUpdates](http/get-updates.md), [sendMessage](http/send-message.md), [answerCallbackQuery](http/answer-callback-query.md).
- [Исходящая доставка](operations/send.md), [команды](operations/commands.md), [координатор](operations/coordinator.md), [polling](jobs/polling.md).

## Источники

Применять [bot.ts](../../../src/bot.ts), [bot-commands.ts](../../../src/bot-commands.ts), [worker/commands.ts](../../../src/worker/commands.ts) и ветви Bot в [main.ts](../../../src/main.ts). Протокол сверять с [официальным Bot API](https://core.telegram.org/bots/api), версия 10.3 от 24.08.2026. Контракт адаптера определять по перечисленным исходникам, не приписывать ему все возможности API.
