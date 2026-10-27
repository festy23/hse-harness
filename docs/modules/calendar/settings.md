# Настройки Calendar

| Название | Тип | Обязательность | Значение по умолчанию | Описание |
|---|---|---|---|---|
| `features.icloudCalendar` | boolean | Нет | true | Допуск iCloud |
| `features.googleCalendar` | boolean | Нет | false | Допуск Google |
| `features.yandexCalendar` | boolean | Нет | undefined, провайдер запрещён | Допуск Yandex |
| `calendars.timetable` | `{provider,id}` | Нет | `{provider:icloud,id:your-icloud-timetable-url}` | Исходное расписание |
| `calendars.agent` | `{provider,id}` | Нет | `{provider:icloud,id:your-icloud-agent-calendar-url}` | Календарь обязательств |
| `ICLOUD_USERNAME`, `ICLOUD_APP_PASSWORD` | secret string | Для iCloud | Нет | Basic credentials |
| `YANDEX_CALENDAR_USERNAME`, `YANDEX_CALENDAR_APP_PASSWORD` | secret string | Для Yandex | Нет | Basic credentials |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret string | Для Google refresh | Нет | OAuth client |
| `pollSeconds` | number | Из Core | Из Core | Интервал синхронизации после завершения цикла |
| `calendarRequest` | Константа ms | Да | 30000 | HTTP request budget |
| `calendarScan` | Константа ms | Да | 120000 | Открытие/чтение коллекции |
| `calendarMutation` | Константа ms | Да | 90000 | Изменение коллекции |
| `MAX_CALENDAR_BYTES` | Константа bytes | Да | 8388608 | Потоковый лимит HTTP-ответа |

`provider` должен быть одним из `icloud|google|yandex`, `id` — непустой после trim строкой. Обе роли должны пройти feature flag до первого подключения. Равные provider и id должны приводить к ошибке. Дальнейшее сравнение identity должно запрещать использование одной коллекции для двух ролей. Источник настроек: [config.ts](../../../src/config.ts).
