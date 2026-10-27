# Конфигурация и JSON-границы

## Метод

readConfigFile, parseConfig, loadConfig, calendarSettings, assertCalendarEnabled,
secret, dataDir, secretsDir, directories и функции validation.

## Ресурсы

[Настройки](../settings.md), process.env, config JSON, каталоги data/secrets/pi.

## Входные и выходные параметры

readConfigFile возвращает Record<string,unknown>; parseConfig принимает unknown
и возвращает Config по [схеме](../settings.md). loadConfig объединяет эти операции.
calendarSettings возвращает features/calendars; directories возвращает Promise<void>.

## Алгоритм работы

1. readConfigFile читает STUDY_CONFIG либо config.local.json как UTF-8. ENOENT
   преобразовать в `Настрой агента: hse-harness setup (из исходников: npm run harness)`.
   Остальные ошибки чтения передать без замены.
2. JSON.parse результата должен дать non-null non-array object; иначе отклонить.
3. parseConfig отклоняет legacy timetableId/agentCalendarId без calendars, неверные
   ownerId/chats, folders не string[], model не string, неfinite pollSeconds и
   значение pollSeconds*1000 > 2147483647. Применить defaults и clamp settings.
4. Каждый chat собрать только из id/title/allowQuestions. Каждый profile собрать
   из заданных полей после проверки типов и диапазона course. Не копировать
   произвольные top-level поля исходного объекта в Config.
5. calendarSettings выполняет shallow merge defaults и raw.features/calendars.
   Проверить boolean flags, у каждой selection допустимый provider и непустой id,
   включённость провайдера, различие timetable и agent по provider/id.
6. Вернуть Config по таблице settings. Валидация не проверяет существование
   календарей, доступность Telegram и наличие модели в подписке.
7. dataDir/secretsDir разрешают configured path через path.resolve относительно cwd.
   directories создаёт параллельно dataDir, secretsDir и dataDir/pi с recursive/0700.

## Общие функции validation

| Метод | Условие успеха | Результат | Ошибка при нарушении |
|---|---|---|---|
| isRecord | object, non-null, non-array | boolean | Не бросает |
| record | isRecord=true | Тот же object | Expected a JSON object |
| parseRecord | JSON.parse затем record | Record | SyntaxError либо record error |
| stringArray | array, каждый item string | Тот же array | Expected a string array |
| numberArray | array, каждый item finite number | Тот же array | Expected a number array |
| requiredString | typeof string | То же значение | Expected a string |
| requiredNumber | finite number | То же значение | Expected a finite number |
| optionalBoolean | undefined либо boolean | То же значение | Expected a boolean |

## Результаты и ошибки

Все синхронные ошибки проверки завершают конфигурацию до запуска интеграций.
loadConfig передаёт их как rejected Promise. Никакие отсутствующие настройки
не должны записываться автоматически этими функциями.

Источники: [config.ts](../../../../src/config.ts), [validation.ts](../../../../src/validation.ts).
