# get_schedule

## Метод

Pi tool `get_schedule`; [общая оболочка](tools.md).

## Описание

Чтение занятий диапазона.

## Ресурсы

[Calendar.lessons](../../calendar/operations/study-calendar.md), deadline.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| from/to | string | Да | Дата либо ISO со смещением |

## Выходные параметры

Lesson[]: id,title,start,end,allDay? по Calendar.lessons.

## Результат в случае успеха

Вернуть результат в [общей JSON text оболочке](tools.md).

## Результат в случае ошибки

Отклонить execute Promise; завершённые внешние/локальные действия не откатывать.

## Алгоритм работы

1. Нормализовать from/to через deadline.
2. При to<=from либо to-from>31*86400000 завершить interval. Ровно 31 день допускается.
3. Вызвать calendar.lessons(normalizedFrom,normalizedTo,ctx); вернуть массив.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| interval | exception | Допустим период до 31 дня | Неверный интервал |
| dependency | exception | Из deadline/Calendar | Дата/чтение/отмена |
