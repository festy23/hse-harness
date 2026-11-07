# Синхронизация расписания

## Описание

Доставка изменений timetable в очередь учебного агента.

## Запуск

Цикл источника `Календарь` в [main.ts](../../../../src/main.ts); после завершения пауза pollSeconds, бюджет одного запуска 120000 ms, сигнал sourceAbort. Вызов `StudyCalendar.syncSchedule(store,ctx?)`.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| store | Store | Да | Общее состояние |
| ctx | OperationContext | Нет | Родительский предел |

## Результат

Успех `{complete:true,initialComplete:true}`. При ошибке отклонить Promise, не публиковать успешный прогресс; ранее сохранённые порции очереди оставить. Следующий цикл должен снова прочитать прежний cursor, если его фиксация не завершилась.

## Ресурсы

[Store, snapshot и tokens](../database/README.md), timetable.changes, Core.enqueue.

## Алгоритм работы

1. В source operation прочитать `key=timetable.identity`, передать `store.state.calendarTokens[key]` в changes. Отсутствующий token передать undefined. После результата проверить abort.
2. Прочитать `cursors[calendarSnapshot:${key}] ?? '[]'`, JSON.parse и stringArray; ошибку формата пробросить. Создать before:Set из массива, current = пустое множество для full, иначе копия before.
3. Пройти result.events в исходном порядке: cancelled удаляет id из current, иной статус добавляет. Создать копию массива events.
4. При full для каждого id в before, отсутствующего в current и в исходном events, добавить `{id,title:'Занятие удалено из расписания',status:'cancelled'}`.
5. Преобразовать каждый event в Source по таблице. Последовательно вызвать Store.enqueue порциями по 20 с проверкой abort перед каждой. Применить дедупликацию Store; ошибка должна прервать цикл без отката предыдущих enqueue.
6. Проверить abort; записать snapshot = JSON.stringify([...current]). При truthy result.cursor записать calendarTokens[key], иначе удалить его. Вызвать Store.save; только после успешного завершения вернуть результат.

| Поле Source | Источник или правило формирования |
|---|---|
| id | `calendar:${key}:${event.id}` |
| kind | calendar |
| date | event.start, иначе HISTORY_FROM=`2026-09-01T00:00:00+03:00` |
| text | JSON.stringify объекта title,start,end,allDay,status,description,recurrence; undefined-поля JSON пропускает |
| deleted | event.status === cancelled |

Полный снимок CalDAV должен сравниваться с предыдущим даже после рестарта. Ошибка чтения не должна интерпретироваться как пустой снимок и не должна создавать отмены.
