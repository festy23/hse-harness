# Кэши и процессное состояние Study

| Ресурс | Тип/форма | Время жизни и размер | Формирование/инвалидация |
|---|---|---|---|
| Scheduler.tails | In-memory Map<string,Promise<void>> | До завершения очереди ключа; число активных task/notice/legacy ключей | Ключ task:${id}, notice:${key} или legacy; удалить завершённый tail, только если Map всё ещё содержит этот tail |
| Scheduler.scope | In-memory AsyncLocalStorage<Set<string>> | Async-вызов с удерживаемыми ключами | Копировать текущий набор при входе; использовать для реентерабельности |
| Scheduler.epochs | In-memory Map<taskId,number> | До уничтожения Scheduler; число встреченных taskId, явного лимита нет | Увеличить при каждом нерекурсивном admission task lock; не очищать |
| Approvals.inFlight | In-memory Set<approvalId> | Пока execute выполняется | Добавить до внешнего действия; удалить в finally; повторный execute с тем же id завершить без действия |

Долговечные jobs/delivered/notices не должны трактоваться как кэш; после рестарта восстанавливать их из Store. Процессные блокировки между процессами не действуют; единственного активного worker обеспечивает Core/Runtime.
