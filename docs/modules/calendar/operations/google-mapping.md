# Отображение GoogleEvent

## Метод

Внутренние `encode(CalendarEvent)` и `decode(GoogleEvent)`.

## Описание

Хранение полей события и учебных метаданных в Calendar v3.

## Ресурсы

[Task](../../core/operations/domain.md); [provider](../../../../src/calendar/providers/google.ts).

## Входные параметры

CalendarEvent или GoogleEvent из [HTTP](../http/google-request.md).

## Выходные параметры

| Поле encode | Источник |
|---|---|
| id,summary,description | event.id,event.title,event.description |
| status | event.status ?? confirmed |
| start/end | Только при truthy границе; allDay: `{date:value}`, иначе `{dateTime:value,timeZone:Europe/Moscow}` |
| extendedProperties.private | Только при task: studyAssistant='1', taskParts=число частей строкой, task0..taskN-1=JSON Task, части ≤900 UTF-8 bytes без разрыва codepoint |
| reminders | Только при task: `{useDefault:false}` |

| Поле decode | Источник |
|---|---|
| id/title | id / summary??'Занятие' |
| description | description |
| start/end | dateTime ?? date соответствующей границы |
| allDay | Boolean(start.date) |
| status | cancelled только для status=cancelled, иначе confirmed |
| recurrence | recurrence?.join('\n') |
| task | При truthy raw: validateTask(JSON.parse(raw)); иначе поле отсутствует |

## Результат в случае успеха

Объект из таблицы. encode не должен переносить recurrence. decode не должен фильтровать по studyAssistant.

## Результат в случае ошибки

Выбросить ошибку metadata или Task/JSON validation; частичное событие не возвращать.

## Алгоритм работы

1. encode должен пройти JSON.stringify(task) по Unicode codepoint; перед добавлением символа, увеличивающего UTF-8 размер >900, завершить текущую часть. Добавить последнюю непустую часть. Записать таблицу полей.
2. decode должен вычислить parts=Number(private.taskParts??0); потребовать safe integer 0..32. raw=private.task, если значение не nullish; иначе при parts>0 соединить task0..taskN-1, подставляя '' для отсутствующих. При parts=0 raw отсутствует. Применить таблицу.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| payload-limit | exception | Некорректные метаданные задания | parts вне 0..32 или не safe integer |
| parse | exception | Из JSON.parse/validateTask | Неверные метаданные Task |
