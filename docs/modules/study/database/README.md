# Ресурсы Study

Физические поля State, Approval, TaskOperation и Job должны соответствовать [Core](../../core/database/README.md). PostgreSQL, Redis и отдельный файл состояния этого модуля отсутствуют.

| Ресурс | Ключ/выборка | Назначенные писатели |
|---|---|---|
| taskOperations | `${turnId}:${taskId}:${SHA256(taskPayload)}` | apply/recoverTaskOperations; pending/applied/notified/conflict/superseded |
| jobs | taskId и id=`${taskId}:${SHA256(deadline)}:${hours}` | Scheduler.syncTask/sync/refresh; часы 72,24,1 |
| notices | urgent/calendar-conflict/calendar-uncertain/stale-lesson/blocked-approval ключи | Scheduler, task operations, Approvals |
| delivered | ID job/notice/digest/no-answer | Scheduler, Approvals, agent loop |
| approvals | UUID id | Approvals.propose/decide/recover/reply |
| queue | digest id | Scheduler.digests и agent loop |
| missedDigests | `digest:${moscowDate}:${10\|20}` | Scheduler.digests и agent loop |
| bootstrapFinished | Один boolean | Команда первоначальной сверки; Study только читает |

`Store.save/flush` должны использовать [контракт фиксации Core](../../core/operations/persistence.md). Внутрипроцессные замки Scheduler не должны считаться дисковыми транзакциями. Внешний календарь, Telegram и локальные сохранения не образуют атомарную транзакцию. Неизвестный исход записи работы должен сохранять намерение для readback и запрещать слепой повтор PUT.
