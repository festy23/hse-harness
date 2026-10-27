# Изменение работы с восстановлением

## Метод

`applyTaskOperation(calendar,scheduler,store,turnId,requestedTask,ownerTurn,ctx?) -> Promise<Task>`; внутренний `complete(operation)`.

## Описание

Долговечное намерение изменения календарного обязательства.

## Ресурсы

[Store](../database/README.md), [Scheduler](scheduler.md), [Calendar](../../calendar/operations/study-calendar.md), [доменные правила](../../core/operations/domain.md).

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| calendar/scheduler/store | Объекты модулей | Да | Чтение/запись, замок, намерения |
| turnId | string | Да | ID порции агента |
| requestedTask | Task | Да | Полный желаемый объект |
| ownerTurn | boolean | Да | Только личный непересланный prompt владельца |
| ctx | OperationContext | Нет | Родительский предел |

## Выходные параметры

Копия operation.desiredTask после complete; не обязательно равна requestedTask по status.

## Результат в случае успеха

Вернуть Task после подтверждённого календарного состояния. При сохранённом urgent notice и временной ошибке доставки complete может завершить успешно с phase=applied, оставив доставку на следующий цикл.

## Результат в случае ошибки

Не откатывать внешний календарь и уже сохранённое намерение. Исключение CalendarOperationConflict должно иметь `source='state-conflict'`. Fatal ошибки должны немедленно пробрасываться.

## Алгоритм работы

1. Клонировать validateTask(requestedTask). taskPayload должен быть JSON-массивом `[id,title,course,status,deadline??null,deadlineBasis,sources,disputed,notes]`; same(a,b) означает равенство отсутствия либо равенство taskPayload. desiredVisible(actual,desired) означает отсутствие actual для cancelled/без deadline, иначе same.
2. id=`${turnId}:${requested.id}:${SHA256(taskPayload(requested))}`. Войти в Scheduler.transaction по requested.id и tool operation 90000 ms. Если taskOperations[id] существует, выполнить Complete и вернуть копию его desiredTask без нового намерения.
3. Прочитать calendar.listTasks с проверкой abort до/после. before=первый task с requested.id либо undefined. Для любой предыдущей операции этой работы в pending/applied, где phase=applied или writeAttempted!==false, потребовать desiredVisible(before,previous.desiredTask); иначе завершить earlier-write.
4. Если requested.status done/submitted отличается от before.status и ownerTurn=false, завершить owner-status. Если ownerTurn=false, before.status done/submitted, requested.status=open, заменить desired.status на before.status; прочие поля оставить из requested.
5. Создать намерение по таблице. Для прежних pending/applied/conflict этой работы установить superseded и supersededBy=id, если прежняя conflict, либо pending с writeAttempted=false, либо её desiredVisible(before) истинно. Удалить notices calendar-conflict/uncertain этих superseded операций.
6. Записать taskOperations[id]=намерение, Store.save. Вызвать Complete с уже прочитанным snapshot. Вернуть structuredClone(validateTask(desiredTask)).

| Поле TaskOperation | Источник или правило формирования |
|---|---|
| id/taskId | Вычисленный id / desired.id |
| beforeTask | Копия before, отсутствует при отсутствии before |
| desiredTask | Копия desired |
| phase | pending |
| writeAttempted | false |
| notify | store.state.bootstrapFinished на момент создания |
| created | Date.now() |

### Complete

1. Для notified/superseded завершить без действий. Иначе использовать переданный snapshot или прочитать calendar.listTasks; найти actual по taskId.
2. Если desiredVisible ложно: для phase=conflict завершить conflict-await; при !same(actual,beforeTask) выполнить Conflict ниже. Для phase=applied завершить accepted-invisible без записи. Для writeAttempted!==false завершить unknown-outcome без записи.
3. Установить writeAttempted=true и Store.save **до** calendar.putTask(copy(desiredTask)). Проверить abort. Fatal из put пробросить; иную ошибку запомнить как writeError.
4. При writeError выполнить listTasks. Если чтение завершилось нефатальной ошибкой, вернуть writeError; fatal пробросить. При всё ещё невидимом desired и изменённом before выполнить Conflict; при неизменном before вернуть writeError. При видимом desired продолжить. Без writeError продолжить независимо от немедленной видимости.
5. MarkApplied: phase=applied; удалить urgent notices этой работы кроме текущего urgent key и calendar-uncertain текущей операции; вызвать scheduler.syncTask(taskId,desiredTask), тем самым сохранить состояние. Если put был успешен без writeError, перечитать listTasks. Если desired уже был видим в шаге 1 и phase!=applied, выполнить MarkApplied без put.
6. Проверить desiredVisible на последнем snapshot. При неизменном before вернуть accepted-invisible; при третьем состоянии выполнить Conflict. Иначе scheduler.syncTask(taskId,actual). Удалить устаревшие urgent notices.
7. При operation.notify вызвать scheduler.urgent(desiredTask,beforeTask,Date.now(),ctx). Fatal пробросить. Иную ошибку пробросить, если текущего urgent notice нет; если notice существует, Store.flush и успешно завершить с прежней phase.
8. Установить phase=notified, удалить calendar-conflict и calendar-uncertain этой операции, Store.save; завершить.

### Conflict

1. Установить phase=conflict; удалить все urgent notices taskId.
2. Записать `calendar-conflict:${operation.id}` со строкой `Календарь изменился во время обработки «${operation.desiredTask.title}». Сохранённое изменение не применено поверх новых данных. Проверь актуальную работу и уточни желаемый результат.`; удалить calendar-uncertain этой операции.
3. Вызвать scheduler.syncTask(taskId,actual), сохранив phase и notice вместе с jobs; выбросить CalendarOperationConflict.

### Маппинг последующих записей

| Выборка записи | Поля записи | Правило |
|---|---|---|
| Текущее taskOperations[id] перед PUT | writeAttempted | true; остальные поля без изменения |
| Текущее taskOperations[id] после принятия/видимости | phase | applied; остальные поля без изменения |
| Текущее taskOperations[id] после доставки/отсутствия urgent | phase | notified; остальные поля без изменения |
| Текущее taskOperations[id] при третьем состоянии | phase | conflict; остальные поля без изменения |
| Допущенные предыдущие операции taskId | phase, supersededBy | superseded, id нового намерения; остальные поля без изменения |
| Jobs taskId | Полная замена производных jobs | [syncTask](scheduler.md), вход actual либо desired согласно шагу |

Отсутствие события для cancelled/без deadline должно подтверждать желаемое видимое состояние. Сам desiredTask при этом должен сохраняться в журнале TaskOperation; listTasks не должен возвращать его из этого журнала.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| earlier-write | exception | Earlier calendar write must be reconciled before a newer task change | Предыдущее намерение не сверено |
| owner-status | exception | Личный статус может менять только владелец в своем диалоге | Попытка нового done/submitted из источника |
| conflict-await | CalendarOperationConflict | Calendar operation awaits resolution | Существующий conflict не соответствует desired |
| conflict | CalendarOperationConflict | Calendar task differs from both the saved before-state and desired result | Третье состояние |
| accepted-invisible | exception | Accepted calendar write is not visible yet… | Не повторять принятый PUT |
| unknown-outcome | exception | Previous calendar write outcome is unconfirmed; refusing a blind repeat | Маркер попытки true/отсутствует |
| dependency | exception | Из Calendar/Store/Scheduler/validateTask | Ошибка ресурса, данных, отмена |
