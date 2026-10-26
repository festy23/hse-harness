# Study

## Назначение

Модуль должен применять изменения учебных обязательств, поддерживать напоминания и сводки, исполнять отдельно подтверждённые внешние действия. Контракт фиксирует ревизию `f3bacd3`.

## Границы ответственности

Учебные статусы должны различать open, done, submitted, cancelled. Done не должен означать сдачу и не должен отключать напоминания. Истёкший срок не должен автоматически изменять статус. Отмена должна удалять событие обязательства, а удаление источника само по себе не является отменой.

Модуль не должен напрямую интерпретировать учебные сообщения: интерпретация принадлежит [Assistant](../assistant/README.md). Проверка владельца Bot API и исходящая доставка принадлежат [Telegram Bot](../telegram-bot/README.md); отправка согласованного вопроса идёт через [MTProto Sources](../sources/README.md).

## Зависимости и контракты

- [Ресурсы](database/README.md), [кэши](caches.md), [настройки](settings.md).
- [Применение изменения работы](operations/task-operation.md), [сериализация и jobs](operations/scheduler.md).
- [Создание одобрения](operations/propose-approval.md), [решение и исполнение](operations/decide-approval.md).
- [Напоминания и notices](jobs/reminders.md), [сводки](jobs/digests.md), [восстановление работ](jobs/recover-tasks.md), [восстановление одобрений](jobs/approvals.md).
- [Core Store](../core/database/README.md), [Calendar](../calendar/README.md).

## Источники

Поведение должно соответствовать [scheduler.ts](../../../src/scheduler.ts), [approvals.ts](../../../src/approvals.ts), [task-operations.ts](../../../src/worker/task-operations.ts), [domain.ts](../../../src/domain.ts) и сборке [main.ts](../../../src/main.ts).
