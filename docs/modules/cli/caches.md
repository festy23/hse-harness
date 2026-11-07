# Память CLI

Redis и долговечный кэш не используются.

| Тип | Форма | Время жизни и размер | Формирование и инвалидация |
|---|---|---|---|
| in-memory | SetupState.version: исходный текст config либо undefined | Один загруженный config | load; заменить после commit; использовать для optimistic conflict check |
| in-memory | SetupState.config: SetupConfig | Жизнь CLI | normalize load; менять внутри раздела; rollback structuredClone |
| in-memory | pending: Map envName→value | Один раздел; по одной записи на изменённую переменную | env; очистить finally transaction |
| in-memory | authBackups: Map absolutePath→text\|undefined | До3 защищённых auth файлов в разделе | protectAuth до первого внешнего входа; очистить finally |
| in-memory | Calendar provider→Choice[] | До3 провайдеров, один шаг calendars | Один discovery на уникальный provider; удалить при возврате шага |
| in-memory | Google discovery Map calendarId→Choice, Set pageToken | До конца discovery; явного лимита календарей нет | Последняя запись id заменяет значение с сохранением позиции; repeat token — ошибка |
| in-memory | Telegram discovery Map chatId→Choice | До конца discovery; один элемент на id | Первая запись id сохраняется; после discovery сортировка ru label |

Ошибки чтения auth в status должны трактоваться как отсутствие сохранённого входа. Ошибка чтения основного config, отличная от ENOENT, должна останавливать CLI с SetupIssue.
