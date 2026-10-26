# Sources

## Назначение

Модуль поставляет текстовые свидетельства учебных источников в очередь Store: выбранные Telegram группы/каналы через личный MTProto аккаунт и почтовые папки через IMAP. Фиксировать контракт ревизии `f3bacd3`.

## Границы ответственности

Читать доступную историю с `HISTORY_FROM=2026-09-01T00:00:00+03:00`, отслеживать новые и изменённые Telegram сообщения и известные удаления. Не выводить из удаления отмену задания. Внешний текст передавать как Source, а не инструкции агенту. Не отправлять почту. MTProto question разрешать только для выбранного чата с `allowQuestions!==false`; пользовательское подтверждение и устойчивый randomId принадлежат [Study](../study/README.md). Добавление чата не должно вступать в него. Получение личного диалога с ботом принадлежит [Telegram Bot](../telegram-bot/README.md).

## Зависимости

Использовать teleproto, big-integer, ws/https-proxy-agent для MTProto; imapflow для почты; [Core](../core/README.md) для Store, конфигурации, OperationContext и HTML compute; [Study](../study/README.md) для обработки ответов на вопросы; Bot notifier для предупреждений о неполном Telegram потоке. HTTP и gRPC методов модуль не предоставляет; MTProto и IMAP являются самостоятельными протоколами, их вызовы определены в operations и jobs.

## Контракты

- [Ресурсы](database/README.md), [кэши](caches.md), [настройки](settings.md).
- [MTProto клиент и подключение](operations/connect-telegram.md), [RPC transport](operations/telegram-rpc.md), [диалоги и страницы истории](operations/telegram-pages.md).
- [Выбор и добавление чата](operations/chats.md), [Source mapping](operations/telegram-sources.md), [чтение и отправка](operations/history-question.md).
- [Telegram poll](jobs/telegram-poll.md), [Telegram reconciliation](operations/reconcile.md), [difference](operations/difference.md).
- [Mail poll](jobs/mail-poll.md), [текст MIME](operations/mail-text.md), [защита IMAP соединения](operations/imap-session.md).

## Исходники

[telegram.ts](../../../src/telegram.ts), [telegram-client.ts](../../../src/telegram-client.ts), [telegram-transport.ts](../../../src/telegram-transport.ts), [telegram-chats.ts](../../../src/telegram-chats.ts), [mail.ts](../../../src/mail.ts), [imap-session.ts](../../../src/imap-session.ts). Общий sourceLoop определяется [Core worker](../core/jobs/worker.md), запись config — [Core](../core/README.md).
