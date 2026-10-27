# Работы и занятия

## Метод

`StudyCalendar.listTasks`, `putTask`, `lessons`, `changeLesson`, `lessonPreview`, `lessonMatches`.

## Описание

Преобразование учебных сущностей в календарные события.

## Ресурсы

Коллекции `agent` и `timetable`, [доменные Task/Lesson и deadline](../../core/README.md), [коллекции](collections.md).

## Входные параметры

| Метод | Вход | Ограничение |
|---|---|---|
| listTasks | ctx? | Нет |
| putTask | task:Task, ctx? | validateTask; JSON UTF-8 ≤20000 bytes для записываемого события |
| lessons | from:string, to:string, ctx? | Передать в range без дополнительной проверки |
| changeLesson | id,start,end:string,ctx? | Нормализовать deadline; end > start |
| lessonPreview | id:string,ctx? | Событие не cancelled |
| lessonMatches | id,start,end:string,ctx? | Сравнение текущего интервала |

## Выходные параметры

| Метод | Результат |
|---|---|
| listTasks | Task[] в порядке agent.list |
| putTask, changeLesson | void |
| lessons | Lesson[] в порядке timetable.range |
| lessonPreview | `${title}\nСейчас: ${start ?? 'Неизвестно'} → ${end ?? 'Неизвестно'}` |
| lessonMatches | boolean |

## Результат в случае успеха

Применить соответствующую ветвь алгоритма. Локальный Store непосредственно не изменять.

## Результат в случае ошибки

Пробросить ошибку зависимости/валидации; удалённую запись не откатывать.

## Алгоритм работы

1. `listTasks`: вызвать agent.list(ctx); оставить события с truthy task и status != cancelled. Для каждого клонировать task верхнего уровня и применить validateTask. Когда task.deadline и event.start существуют и их epoch различаются, заменить только deadline на deadline(event.start).value. Вернуть массив; срок без task.deadline из event.start не добавлять.
2. `putTask`: применить validateTask, вычислить event id = первые 40 hex SHA-256(task.id). Для cancelled или отсутствующего deadline вызвать agent.remove(id,ctx) и завершить. Иначе проверить размер JSON и вызвать agent.put с полями ниже.
3. `lessons`: вызвать timetable.range(from,to,ctx); оставить неотменённые события с start и end. Вернуть id/title/start/end без изменения и `allDay:true` только при truthy event.allDay.
4. `changeLesson`: нормализовать start/end через deadline; отклонить end <= start; вызвать timetable.move(id,normalizedStart,normalizedEnd,ctx).
5. `lessonPreview`: вызвать timetable.get(id,ctx); cancelled завершить `cancelled-lesson`, иначе вернуть строку из таблицы результатов.
6. `lessonMatches`: вызвать timetable.get(id,ctx). Для cancelled либо отсутствующего start/end вернуть false. Для allDay сравнить event.start/end с московскими датами нормализованных входных start/end; иначе сравнить обе пары нормализованных ISO-строк. Вернуть true только при равенстве обеих границ.

| Поле запроса agent.put | Источник или правило формирования |
|---|---|
| id | SHA-256(task.id).slice(0,40) |
| title | Префикс `✓ ` только для submitted, затем `${course}: ${title}` |
| start | Нормализованный task.deadline |
| end | deadline + 15 минут, ISO UTC |
| status | confirmed |
| task | Результат validateTask |
| description | notes; новая строка `Статус: ${status}`; `Основание срока: ${deadlineBasis}`; при disputed строка `Срок спорный.`; `Источники:` и sources через новую строку |

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| task-validation | exception | Из validateTask | Недопустимые поля Task |
| task-size | exception | Описание слишком длинное; сократите notes/источники | JSON >20000 bytes |
| interval | exception | Некорректный интервал занятия | end <= start |
| cancelled-lesson | exception | Занятие уже отменено | preview отменённого события |
| dependency | exception | Из коллекции/deadline | Чтение, запись, дата, отмена |
