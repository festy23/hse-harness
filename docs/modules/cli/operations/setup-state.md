# Транзакция раздела настройки

## Метод

SetupState.load/prepare/save/env/protectAuth/transaction/profile/calendars; normalizeSetupConfig; upsertEnv.

## Описание

Сохранить согласованный раздел и компенсировать его отмену без потери соседних настроек.

## Ресурсы

[CLI files](../database/README.md), process.env, [Core writeSecret](../../core/operations/persistence.md), [config write lock](../../core/operations/locking.md).

## Входные параметры

value — unknown Config; env(name,value) — strings; transaction(action) — async callback; protectAuth — только google.json/pi-auth.json/telegram.session; profile — StudyProfile; calendars — timetable/agent selections.

## Выходные параметры

normalizeSetupConfig — SetupConfig; upsertEnv — полный dotenv текст; transaction — значение action после успешного commit. Остальные методы — void.

## Результат в случае успеха

commit должен записать dotenv перед config, обновить version и config в памяти. save внутри transaction должен не писать файлы до завершения action.

## Результат в случае ошибки

Настройка должна восстановить clone config, защищённые auth и изменённые process.env. Ошибка восстановления ресурса может заменить первоначальную ошибку. Crash между несколькими файлами не обеспечивает автоматической транзакционной компенсации.

## Алгоритм работы

1. load должен optional-read config: ENOENT→undefined; другая ошибка→READ. JSON.parse(version??'{}'); syntax error→INPUT без записи. normalize требует object не array/null; legacy timetableId/agentCalendarId без calendars запрещены; calendars/features, если присутствуют, должны быть objects не arrays/null.
2. Получить Core calendarSettings(raw), преобразуя ошибку в SetupIssue. Сформировать defaults ownerId0/chats[]/folders[]/model''/pollSeconds60, затем spread raw и calendarSettings. ownerId safe integer>=0; chats — array объектов с числовой строкой id, строкой title, allowQuestions отсутствует либо boolean; folders string[]; model string; pollSeconds finite>=15; profile при наличии должен соответствовать [схеме](../database/README.md). Иначе INPUT. Неизвестные поля сохранить.
3. upsertEnv должен требовать имя `^[A-Z][A-Z0-9_]*$`, value без CR/LF/NUL. Выбрать первую отсутствующую в value quote из `'`, backtick, `"`; double quote также не допускается при literal backslash+n/r в value. Если quote не найдена — INPUT. Удалить строки matching `^\s*(?:export\s+)?NAME\s*=`, удалить пустые хвостовые строки; добавить `NAME=quote+value+quote` и завершающую пустую строку; соединить LF. Не интерпретировать `$`, backticks или shell substitutions.
4. transaction должна запретить вложенный pending. Сделать structuredClone config, snapshot process.env, новый changes Map и backups Map; назначить pending/authBackups до action.
5. env должен предварительно выполнить upsertEnv('',name,value). Вне transaction вызвать transaction(()=>env(...)); внутри changes.set и немедленно process.env[name]=value. protectAuth вне transaction — TRANSACTION; внутри сохранить исходный текст/undefined только при первом вызове для пути.
6. profile должен заменить config.profile и save. calendars должен вычислить features по присутствию provider в обеих ролях, calendarSettings({features,calendars}), assign config, удалить legacy fields, save. save внутри pending — no-op; вне — commit(empty Map).
7. После успешного action commit должен взять withConfigWriteLock(configPath). Внутри normalize config; повторно optional-read config и сравнить текст строго с version. Несовпадение — CONFLICT до записи файлов. Прочитать исходный env, применить изменения в порядке Map; mkdir parents0700.
8. При changes.size>0 writeSecret envPath; затем writeSecret configPath JSON+LF. Если config write отклонён, восстановить originalEnv через writeSecret либо unlink новый env; затем бросить ошибку. При успехе config=validated, version=nextVersion; release lock средствами Core; вернуть action result.
9. При любой ошибке action/commit восстановить previousConfig. Для каждого auth backup: undefined→unlink с игнорированием только ENOENT; текст→writeSecret. В finally восстановления вернуть process.env только для изменённых names (delete, если прежнего не было). Бросить ошибку; во внешнем finally очистить pending/authBackups.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| INPUT | SetupIssue | Некорректный JSON / поле… / Значение настройки… | Нормализация и dotenv |
| READ | SetupIssue | Не удалось прочитать файл настроек… | Ошибка чтения кроме отсутствия |
| TRANSACTION | SetupIssue | Другой шаг… / Авторизация должна… | Недопустимый порядок API |
| CONFLICT | SetupIssue | Настройки изменились в другом окне… | Изменение config после load |
| RESOURCE | rejected Promise | fs/writeSecret/lock error | Не удалось подтвердить commit/компенсацию |
