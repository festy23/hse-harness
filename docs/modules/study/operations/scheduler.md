# Сериализация и обновление jobs

## Метод

`Scheduler.transaction`, `busy`, `syncTask`, `sync`, `refresh`, `nextReminder`.

## Описание

Изоляция изменений одной работы и производных напоминаний.

## Ресурсы

[Процессные замки](../caches.md), [Store](../database/README.md), [reminderJobs](../../core/operations/domain.md), calendar.listTasks.

## Входные параметры

| Метод | Вход |
|---|---|
| transaction | run:()=>Promise<T>, taskId?:string |
| busy | taskId:string |
| syncTask | taskId:string, task?:Task |
| sync | tasks:Task[] |
| refresh | calendar с listTasks, ctx? |
| nextReminder | now:number epoch ms = Date.now() |

## Выходные параметры

transaction возвращает результат run; busy — boolean; syncTask/sync/refresh — void; nextReminder — ближайшее due или undefined.

## Результат в случае успеха

jobs должны отражать разрешённое актуальное состояние задач. Задачи с done сохраняют напоминания, submitted/cancelled/без deadline не создают jobs.

## Результат в случае ошибки

Отклонить Promise; замок освобождается после завершения run даже при исключении. Уже выполненные сохранения других задач не откатывать.

## Алгоритм работы

1. transaction: key=`task:${taskId}` либо legacy без taskId. При наличии key в AsyncLocalStorage вызвать run непосредственно. Иначе увеличить epochs[taskId] на 1 (для taskId); скопировать held keys и добавить key; поставить run после предыдущего tail данного ключа. Tail должен поглощать исход run только для продолжения очереди; вызывающему вернуть исходный result Promise. Удалить tail после завершения, только если он остаётся последним.
2. busy: вернуть tails.has(task key) и отсутствие этого key в текущем scope.
3. syncTask: внутри task transaction заменить jobs на старые jobs с другим taskId, затем reminderJobs(task), либо [] для отсутствующей task. Вызвать Store.save. Не менять delivered.
4. sync: построить Map id→task (последний дубль выигрывает), объединить taskId существующих jobs и keys Map. Для всех id вызвать syncTask(id,Map.get(id)) максимум четырьмя параллельными обработчиками; дождаться всех. При ошибках вернуть первую fatal, иначе первую ошибку.
5. refresh: до чтения календаря снять копию epochs, множество id из jobs и taskOperations, JSON.stringify массива операций каждого id и busy-множество. Затем вызвать calendar.listTasks в source operation 120000 ms. Построить Map и добавить id прочитанных задач.
6. Для каждого id максимум четырьмя обработчиками: пропустить, если был busy, сейчас busy или epoch изменился. Иначе войти в transaction(id). Внутри требовать epoch=снимок+1, неизменный JSON операций и отсутствие pending/applied операции этого id. При невыполнении пропустить; иначе syncTask(id,Map.get(id)). Ошибку календаря/записи пробросить.
7. nextReminder: выбрать jobs с !delivered[id] и due>=now, сортировать due по возрастанию; вернуть due первого, иначе undefined. Просроченные jobs в этот результат не включать.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| dependency | exception | Из run/Store/calendar | Ошибка чтения, записи или отмена |
