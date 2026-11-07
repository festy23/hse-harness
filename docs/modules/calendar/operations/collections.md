# Фабрика и коллекции

## Метод

`createCalendar(settings, registry?) -> Promise<StudyCalendar>`; внутрипроцессный `CalendarCollection`.

## Описание

Выбор провайдера и изоляция календарных ролей.

## Ресурсы

[Настройки](../settings.md), [кэши](../caches.md), [Google HTTP](../http/google-request.md), [CalDAV](../http/caldav-discovery.md).

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| settings | CalendarSettings | Да | Роли и flags |
| registry | map provider → async factory(id,ctx) | Нет | По умолчанию встроенные провайдеры |
| ctx | OperationContext | Нет | Отмена и предел внешних методов |

## Выходные параметры

```yaml
CalendarEvent:
  id: string
  title: string
  description: string?
  start: string?
  end: string?
  allDay: boolean?
  status: confirmed | cancelled # поле необязательно
  recurrence: string?
  task: Task?
CalendarChanges:
  events: CalendarEvent[]
  cursor: string?
  full: boolean
```

## Результат в случае успеха

Создать StudyCalendar с identity каждой обёртки `${provider}:${id}`. Коллекции должны предоставлять следующие контракты; данные не должны дополнительно фильтроваться фабрикой.

| Метод | Вход | Выход |
|---|---|---|
| list | ctx? | Все события коллекции |
| range | from:string, to:string, ctx? | События диапазона, раскрытого провайдером |
| changes | cursor?:string, ctx? | CalendarChanges |
| get | event:string, ctx? | CalendarEvent |
| put | event:CalendarEvent, ctx? | void |
| remove | event:string, ctx? | void |
| move | event:string, start:string, end:string, ctx? | void |

## Результат в случае ошибки

Отклонить Promise без изменения локального Store. Ошибка внешней мутации может означать неизвестный результат удалённой записи.

## Алгоритм работы

1. Проверить flags timetable и agent; при запрещённом провайдере завершить `disabled`.
2. Найти factory обеих ролей. Отсутствующий factory завершает `unregistered`.
3. Создать обёртки без сетевого подключения. Вызвать StudyCalendar; совпавшие identity завершить `same-calendar`.
4. Каждый вызов обёртки должен открыть operation: для `put/remove/move` kind=tool, budget=90000, для остальных source/120000. Родительский ctx должен ограничивать budget.
5. Использовать закэшированную коллекцию или вызвать factory(id,op), проверить abort, сохранить коллекцию. Передать все аргументы метода и op в коллекцию. Вернуть результат; ошибку пробросить. Автоматический повтор фабрика не должна выполнять.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| disabled | exception | Провайдер отключен feature flag | Выбор запрещён |
| unregistered | exception | Не зарегистрирован календарь … | Нет factory |
| same-calendar | exception | Календарь дедлайнов должен отличаться от расписания | Совпала identity |
| dependency | exception | Из вложенного вызова | Транспорт, формат, отмена, бюджет |
