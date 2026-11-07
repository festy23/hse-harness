# Оперативное состояние Core

| Ресурс | Тип, ключ и значение | Время жизни | Размер | Формирование и инвалидация |
|---|---|---|---|---|
| Store.state | in-memory; один объект State | Экземпляр Store | Не ограничен числом записей | load заменяет объект; бизнес-операции меняют поля; save создаёт снимок |
| Store.waiters | in-memory; revision → resolve/reject | До fsync соответствующей revision либо fatal | Не ограничен | save добавляет; commit или failWrite удаляет |
| active operations | in-memory Map UUID → kind/started/deadline | До scope.dispose | Число действующих scopes | createOperation добавляет; dispose удаляет |
| Compute queue | in-memory FIFO Pending | До результата/отмены/close | 1 active + 8 ожидающих по default | run добавляет; finish удаляет |
| Lifecycle scopes | AsyncLocalStorage boolean, count, listeners | Операция/ожидание | Число допущенных операций | run увеличивает count; finally уменьшает; listener удаляется при пробуждении |
| Progress | in-memory name → initialComplete/continuing/lastSuccess/lastError | Worker incarnation | 3 источника | sourceLoop обновляет; запуск восстанавливает только lastSuccess/lastError |
| Responsiveness histogram | in-memory nanoseconds histogram | Окно 60 seconds | Node perf_hooks histogram | resolution 20 ms; reset каждые 60000 ms; close отключает |

Эти структуры не являются дополнительным долговременным хранилищем.
Ошибки записи Store остаются в `writeFailure` до уничтожения экземпляра.
`Responsiveness.snapshot` должен вернуть p95Ms/maxMs с двумя десятичными знаками
и windowSeconds=60. Полного архива измерений этот модуль не хранит.

Источники: [Store](../../../src/store.ts), [ComputeClient](../../../src/compute/client.ts),
[observability](../../../src/worker/observability.ts).
