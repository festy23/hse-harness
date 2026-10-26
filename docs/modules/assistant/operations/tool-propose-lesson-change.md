# propose_lesson_change

## Метод

Pi tool `propose_lesson_change`; [общая оболочка](tools.md).

## Описание

Подготовка переноса занятия.

## Ресурсы

[Approvals.propose](../../study/operations/propose-approval.md), deadline.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| lessonId/start/end | string | Да | ID конкретного занятия и границы |

## Выходные параметры

`{draft:string}`; draft=id из propose.

## Результат в случае успеха

Вернуть результат в [общей JSON text оболочке](tools.md).

## Результат в случае ошибки

Отклонить execute Promise; завершённые внешние/локальные действия не откатывать.

## Алгоритм работы

1. Нормализовать start/end через deadline.
2. Вызвать approvals.propose(lesson,{lessonId,start:normalizedStart,end:normalizedEnd},Date.now(),ctx).
3. Вернуть {draft:id}; изменение расписания не исполнять. ownerTurn здесь не проверяется.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| dependency | exception | Из deadline/Approvals | Интервал, preview, доставка, сохранение |
