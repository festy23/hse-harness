# Настройки Core

## Пути и окружение

| Название | Тип | Обязательность | Значение по умолчанию | Описание |
|---|---|---|---|---|
| `STUDY_CONFIG` | string | Нет | `config.local.json` относительно cwd | Файл конфигурации |
| `STUDY_DATA_DIR` | string | Нет | `data` относительно cwd | Каталог operations и Pi |
| `STUDY_SECRETS_DIR` | string | Нет | `secrets` относительно cwd | Каталог credentials |
| `DOTENV_CONFIG_PATH` | string | Нет | Правило dotenv | Импорт `dotenv/config` загружает окружение |
| `HSE_WORKER_ID` | string | Нет | отсутствует | Managed mode только вместе с process.send |
| `HSE_RELEASE_VERSION` | string | Нет | отсутствует | Версия worker для health IPC |
| `HSE_HARNESS_HOME` | string | Нет | отсутствует | [Корень установки Runtime](../runtime/README.md) |

`secret(name)` должен вернуть непустое значение process.env[name] или завершиться
ошибкой `Не настроен <name>; см. .env.example`; значение ошибки не содержит секрет.

## Конфигурация JSON

| Название | Тип | Обязательность | Значение по умолчанию | Описание |
|---|---|---|---|---|
| `ownerId` | safe positive integer | Да | отсутствует | Telegram owner |
| `chats` | TelegramChat[] | Да | отсутствует | Разрешённые источники |
| `chats[].id` | string `^-?\d+$` | Да | отсутствует | Telegram peer ID |
| `chats[].title` | string | Да | отсутствует | Название |
| `chats[].allowQuestions` | boolean | Нет | undefined | В main вопрос разрешён, кроме literal false |
| `folders` | string[] | Нет | `[]` | IMAP папки |
| `model` | string | Нет | `''` | Идентификатор Pi модели |
| `pollSeconds` | finite number ≤ 2147483.647 | Нет | `60` | Значение ниже 15 нормализуется в 15 |
| `features.googleCalendar` | boolean | Нет | `false` | Google |
| `features.icloudCalendar` | boolean | Нет | `true` | iCloud |
| `features.yandexCalendar` | boolean | Нет | undefined | Yandex |
| `calendars.timetable` | CalendarSelection | Нет | iCloud / `your-icloud-timetable-url` | Расписание |
| `calendars.agent` | CalendarSelection | Нет | iCloud / `your-icloud-agent-calendar-url` | Календарь работ |
| `profile` | StudyProfile | Нет | undefined | При отсутствии Pi получает незаполненный профиль и не подставляет legacyProfile |

CalendarSelection содержит `provider:icloud/google/yandex`, непустой string `id`
и optional `label:string`. Роль использует включённый provider. Одинаковая пара
provider/id у двух ролей запрещена. Прямой calendarSettings не проверяет тип label.
StudyProfile содержит strings `name,university,program,group,academicYear,subjects,details`
и integer `course` от 1 до 6 включительно. Пустые строки этой проверкой разрешены.

## Legacy profile

Экспорт legacyProfile содержит name=`Иван`, university=`ВШЭ ФКН`,
program=`Программная инженерия`, group=`БПИ243`, course=3, academicYear=`2026/27`,
subjects=`Кодинговые агенты в разработке`,
details=`Набор 2024; поток C#; майнор: Финансовые рынки; НИС: Нейроинформатика`.
parseConfig и Pi.open не используют его как default profile. Pi использует совпадение
только group/program/academicYear для допуска начального seed пустой сессии;
[контракт seed](../assistant/operations/session.md).

## Бюджеты операций

| Название | Тип | Обязательность | Значение по умолчанию | Описание |
|---|---|---|---|---|
| rpc | milliseconds | Константа | 30000 | RPC |
| connect | milliseconds | Константа | 120000 | Подключение |
| telegramSlice | milliseconds | Константа | 60000 | MTProto порция |
| history | milliseconds | Константа | 45000 | История/команда tasks |
| question | milliseconds | Константа | 45000 | Вопрос |
| addChat | milliseconds | Константа | 120000 | Добавление чата |
| mailSlice | milliseconds | Константа | 120000 | IMAP порция |
| message | milliseconds | Константа | 45000 | Сообщение |
| calendarRequest | milliseconds | Константа | 30000 | Календарный HTTP |
| calendarScan | milliseconds | Константа | 120000 | Сканирование/фоновые repeat |
| calendarMutation | milliseconds | Константа | 90000 | Изменение календаря/owner handler |
| hse | milliseconds | Константа | 45000 | Чтение HSE |
| cleanup | milliseconds | Константа | 5000 | Завершение интеграции |
| cpu | milliseconds | Константа | 30000 | Вычислительный поток |

Источник: [config.ts](../../../src/config.ts), [operations.ts](../../../src/operations.ts).
