# Бюджеты, отмена и классификация ошибок

## Контракт

createOperation(kind,budgetMs,parent?) → OperationScope;
withOperation(kind,budgetMs,parent,run) → Promise результата run.
kind: source/owner-command/tool/approval/connect/request/cleanup/cpu.
parent: OperationContext, AbortSignal либо undefined.
budgetMs должен быть finite и >0, иначе RangeError `Invalid operation budget`.

## Ресурсы

AbortController, monotonic performance.now, timeout, registry active operations.
Долговременных записей и внешних запросов модуль не выполняет.

## Алгоритм работы

1. Выбрать context, если parent имеет remainingMs; иначе использовать parent как signal.
2. Создать UUID, controller и deadlineMonoMs=now+min(budgetMs,parent.remainingMs либо Infinity).
   Добавить registry запись `{kind,started:now,deadline}`.
3. Если parent.signal уже отменён, сразу отменить child. Иначе подписаться once.
   OperationError reason родителя сохранить; иной reason заменить cancelled
   `Операция отменена`.
4. Установить unref timeout на max(0,deadlineMonoMs-now). По срабатыванию отменить
   с OperationError deadline `Превышено время операции`; reason=request для
   kind=request, operation для остальных kinds.
5. Scope.remainingMs возвращает max(0,deadline-now); throwIfAborted сначала
   устанавливает deadline, если он достигнут, затем вызывает signal.throwIfAborted.
6. Scope.abort(reason?) использует входной reason либо cancelled по умолчанию.
   dispose удаляет timeout, parent listener и registry entry.
7. withOperation проверяет отмену до run и после его await. При исключении fatal
   передать его без замены. Для прочих ошибок сначала проверить отмену scope,
   затем передать исходную ошибку. В finally выполнить dispose.

## Результат

| Поле OperationContext | Источник |
|---|---|
| id | randomUUID |
| kind | Входной kind |
| signal | AbortController.signal |
| deadlineMonoMs | Ограниченный родителем monotonic deadline |
| remainingMs/throwIfAborted | Методы scope |

Бюджет отменяет signal; он не завершает Promise через гонку и не освобождает ресурс
до выхода run. Обработчик обязан передать signal реальной операции либо проверять
его. При некооперативном обработчике фактическое завершение может быть позже deadline.

## Ошибки

FailureKind: cancelled, deadline, transport, rate-limit, authentication, permission,
provider-rejection, protocol, payload-limit, durability, invariant.
OperationError сохраняет kind, message и optional reason drain/stop/request/operation.
fatal=true только для OperationError durability/invariant.
cancelled=true для OperationError cancelled либо Error с name AbortError, если
cause не OperationError либо cause.kind=cancelled; deadline не считается отменой.
asError сохраняет Error identity, иначе создаёт Error(String(value),{cause:value}).

## Вспомогательные операции

operationSleep(ms,ctx?) использует timers/promises с ctx.signal; при отмене
выбрасывает именно ctx.signal.reason. yieldIfNeeded(since,signal?) проверяет отмену,
и при elapsed≥5 ms выполняет setImmediate, проверяет signal повторно и возвращает
новый performance.now; иначе возвращает since.
activeOperations возвращает массив id/kind/ageMs/remainingMs; age округляется,
remaining ограничивается нулём. Записи исчезают только при dispose.

Источник: [operations.ts](../../../../src/operations.ts).
