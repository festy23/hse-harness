# Преобразование iCalendar

## Метод

`calendarCompute(job) -> CalendarEvent | CalendarEvent[] | string`, CPU worker.

## Описание

Чтение, раскрытие повторений, сериализация и перенос VEVENT.

## Ресурсы

`ical.js`, `node-ical`, [Core compute](../../core/operations/compute.md), [Task](../../core/operations/domain.md). Источник: [compute.ts](../../../../src/calendar/compute.ts).

## Входные параметры

```yaml
job:
  type: calendar
  action: list | range | get | serialize | move
  data: string? # обязательно кроме serialize
  url: string? # обязательно list/range
  id: {url: string, recurrenceId: string?}? # обязательно get/move
  from: string? # обязательно range
  to: string? # обязательно range
  event: CalendarEvent? # обязательно serialize
  start: string? # обязательно move
  end: string? # обязательно move
```

## Выходные параметры

`serialize/move` должны вернуть iCalendar text; `get` — событие; `list/range` — массив [CalendarEvent](collections.md).

## Результат в случае успеха

Поле id должно быть `ics.` + base64url(JSON.stringify({url,recurrenceId?})). Для обычного ресурса recurrenceId отсутствует; для экземпляра серии — исходное время/дата экземпляра.

## Результат в случае ошибки

Отклонить compute-вызов; внешний CalDAV не изменять до завершённого результата serialize/move.

## Алгоритм работы

1. `serialize`: потребовать start/end. Создать VCALENDAR version=2.0, prodid=`-//HSE Study Assistant//EN`, один VEVENT. Заполнить uid=`${event.id}@hse-study-assistant`, summary=title, description=description??'', status=CANCELLED только для cancelled, иначе CONFIRMED. Применить шаг 7; если task существует, `x-hse-study-task`=base64 UTF-8 JSON(task). Вернуть toString. Поле recurrence входного event в создаваемый календарь не переносить.
2. Для остальных действий потребовать непустой string data, размер ≤2097152 bytes и корень VCALENDAR. Разобрать ICAL.parse. Для list/range без VEVENT вернуть []. Для прочих ветвей потребовать ровно один master VEVENT без recurrence-id.
3. Для разбора node-ical клонировать root; у dtstart/dtend/recurrence-id/exdate/rdate с floating временем без tzid установить Europe/Moscow. Потребовать ровно одно семейство VEVENT в результате node-ical; несколько UID завершить `family`.
4. `list`: вернуть один master через отображение ниже. `range`: вызвать expandRecurringEvent с from=Date(from), to=Date(to)-1ms, expandOngoing=true. Пропускать CANCELLED; перед добавлением каждого элемента отклонить длину ≥20000. Для серии с rrule/rdate recurrenceId брать из instance.event.recurrenceid, иначе instance.start, в формате даты для allDay, ISO для timed. Для несерии не добавлять recurrenceId. Вернуть массив в порядке расширения.
5. `get`: без recurrenceId вернуть master. Иначе найти override по совпадающему нормализованному recurrenceid; найденный вернуть с его интервалом. Если отсутствует, расширить вокруг искомого instant: timed [at,at+1000ms], allDay [at-86400000,at+86400000]. Найти совпадающий epoch или allDay date. Отсутствие завершить `missing-instance`; найденный вернуть с target id.
6. `move`: для recurrenceId сначала выполнить проверку существования из шага 5. Найти override компонента по recurrence-id; при наличии параметра RANGE отклонить. Если override отсутствует, клонировать master, удалить rrule/rdate/exdate/recurrence-id, добавить recurrence-id как DATE для YYYY-MM-DD либо UTC time, добавить компонент в root. Без recurrenceId при rrule или rdate у master завершить `whole-series`. Применить шаг 7 к выбранному компоненту с allDay=false; остальные компоненты и свойства сохранить; вернуть root.toString.
7. Запись дат: удалить dtstart/dtend/duration. При allDay=true потребовать строки YYYY-MM-DD и записать DATE; иначе записать UTC JSDate. Записать dtstamp и last-modified текущим временем; sequence=Number(старое значение??0)+1.

| Поле CalendarEvent | Источник или правило формирования |
|---|---|
| id | Кодированный ResourceId |
| title | String(summary.val или summary или '') либо `Занятие` |
| description | String(description.val или description или '') |
| start/end | ISO UTC либо YYYY-MM-DD с tz исходной Date, иначе локальной TZ процесса; end по умолчанию start |
| allDay | datetype === date |
| status | cancelled только для CANCELLED, иначе confirmed |
| recurrence | base.rrule?.toString() |
| task | Только при truthy x-hse-study-task master: base64 decode, JSON.parse, validateTask |

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| payload-limit | exception | Событие CalDAV превышает 2 MiB / Слишком много экземпляров календаря | Превышение лимита |
| format | exception | CalDAV не вернул содержимое события / некорректный iCalendar | Неверный ресурс |
| family | exception | CalDAV resource должен содержать одно семейство VEVENT с одним UID | Неоднозначное семейство |
| master | exception | Не найдено однозначное основное событие | Число master !=1 |
| missing-instance | exception | CalDAV: экземпляр занятия больше не существует | Нет occurrence |
| whole-series | exception | Выберите конкретный экземпляр занятия через get_schedule; перенос всей серии не согласован | Запрошен master серии |
| range-series | exception | Перенос RANGE-серии требует отдельного согласования | RANGE у override |
| dates | exception | Для события нужны start/end / Для allDay нужны даты YYYY-MM-DD | Неверный serialize input |
| dependency | exception | Из parser/validateTask | Некорректные метаданные или время |
