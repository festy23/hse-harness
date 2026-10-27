# Calendar

## Назначение

Модуль должен предоставлять учебному состоянию две раздельные календарные роли: `timetable` для исходного расписания и `agent` для событий обязательств. Контракт фиксирует ревизию `f3bacd3`.

## Границы ответственности

Модуль должен преобразовывать события провайдеров в `CalendarEvent`, работы — в события календаря агента, раскрывать экземпляры повторений CalDAV и ставить изменения расписания в очередь источников. Решения о личном статусе, подтверждении переноса, повторах намерений и уведомлениях принадлежат [Study](../study/README.md). Публичные HTTP и gRPC endpoints отсутствуют.

## Зависимости и контракты

- [Core](../core/README.md): доменные типы, Store, бюджеты операций и compute worker.
- [Ресурсы](database/README.md), [кэши](caches.md), [настройки](settings.md).
- [Фабрика и коллекции](operations/collections.md), [работы и занятия](operations/study-calendar.md), [iCalendar](operations/icalendar.md).
- [Синхронизация расписания](jobs/sync-schedule.md).
- [Google HTTP](http/google-request.md), [CalDAV транспорт](http/caldav-discovery.md).

## Источники

Нормативное поведение должно соответствовать [index.ts](../../../src/calendar/index.ts), [collection.ts](../../../src/calendar/collection.ts), [study-calendar.ts](../../../src/calendar/study-calendar.ts), [compute.ts](../../../src/calendar/compute.ts), [http.ts](../../../src/calendar/http.ts), провайдерам [Google](../../../src/calendar/providers/google.ts), [CalDAV](../../../src/calendar/providers/caldav.ts), [iCloud](../../../src/calendar/providers/icloud.ts), [Yandex](../../../src/calendar/providers/yandex.ts) и [Google OAuth](../../../src/google.ts).
