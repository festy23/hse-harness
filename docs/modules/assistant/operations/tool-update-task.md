# update_task

## Метод

Pi tool `update_task`; [общая оболочка](tools.md).

## Описание

Создание или изменение обязательства.

## Ресурсы

[TaskOperation](../../study/operations/task-operation.md), [deadline/validateTask](../../core/operations/domain.md), pi.turnId/ownerTurn.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| id | string | Да | `^[a-z0-9_-]{1,80}$` |
| title | string | Да | 1..250 символов |
| course | string | Да | 1..150 символов |
| status | enum | Да | open/done/submitted/cancelled |
| deadlines | string[] | Да | 0..10 исходных дат |
| basis | enum | Да | explicit/personal-date-rule/schedule/unknown |
| sources | string[] | Да | 1..20, каждая ≤500 символов |
| notes | string | Да | ≤3000 символов |
| disputed | boolean | Да | Явный признак спора |

## Выходные параметры

| Поле результата | Источник или правило формирования |
|---|---|
| task | Task, возвращённый applyTaskOperation |
| calendarUpdated | Boolean(task.deadline) \|\| task.status==='cancelled'; флаг не отражает факт HTTP PUT |

## Результат в случае успеха

Вернуть результат в [общей JSON text оболочке](tools.md).

## Результат в случае ошибки

Отклонить execute Promise; завершённые внешние/локальные действия не откатывать.

## Алгоритм работы

1. Нормализовать все deadlines через deadline; сортировать по epoch по возрастанию. Пустой массив допускается.
2. Построить Task по таблице и validateTask. При ошибке даты/Task завершить validation до создания намерения.
3. Вызвать applyTaskOperation(calendar,scheduler,store,pi.turnId,task,pi.ownerTurn,ctx); вернуть Task результата и вычисленный calendarUpdated.

| Поле Task | Источник или правило формирования |
|---|---|
| id/title/course/status/sources/notes | Одноимённые входные поля |
| deadline | normalized[0]?.value; отсутствует при пустом массиве |
| deadlineBasis | personal-date-rule, если самый ранний normalized имеет такое basis; иначе входной basis |
| disputed | Вход disputed OR число уникальных normalized.value >1 |

При одинаковом моменте даты не должны создавать спор только из-за разных часовых поясов. `ownerTurn=false` должен ограничивать личные статусы по TaskOperation; источник не может присвоить новый done/submitted.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| validation | exception | Из deadline/validateTask | Неверная дата/Task |
| dependency | exception | Из TaskOperation | Конфликт, несверенная запись, owner-status, ресурсы |
