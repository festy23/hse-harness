# Импорт прежней установки

## Метод

importInstallation(source,destination): Promise<void>.

## Описание

Перенести конфигурацию, авторизацию и учебное состояние в новый личный каталог.

## Ресурсы

source config.local.json/.env/data/secrets, source/data/service.lock, staging, destination, [normalize](setup-state.md), [runningPid](process.md).

## Входные параметры

source/destination — пути; оба должны resolve. Destination должен отсутствовать и находиться вне source.

## Выходные параметры

void после rename staging→destination.

## Результат в случае успеха

Исходные файлы должны сохраниться; destination должен содержать приватную копию и исправленный абсолютный sessionPath.

## Результат в случае ошибки

До rename destination не должен создаваться; staging удаляется в finally. Если chmod после rename не удался, destination уже существует и не удаляется компенсацией.

## Алгоритм работы

1. resolve paths; source==destination или относительный путь destination внутри source — INPUT. Любой существующий destination, включая symlink/пустой каталог — INPUT. Source runningPid(source/data) — RUNNING.
2. Прочитать source/config.local.json, JSON.parse, normalizeSetupConfig; ошибка завершает до staging. Создать parent destination recursive0700; stage=destination+'.import-'+UUID, mkdir0700.
3. Для каждого `.env`, `data`, `secrets`, если lstat существует, рекурсивно копировать. Symlink — FILE; directory→mkdir0700 и обход readdir; regular file→readFile/writeFile(wx,0600); иной тип — FILE. Только на верхнем уровне source/data пропустить service.lock и e2e. Прочие содержимое/имена сохранить.
4. Записать normalized config pretty JSON+LF0600. Если stage/data/operations.json существует, parse JSON. При truthy sessionPath взять basename; требовать `.jsonl` suffix и существующий stage/data/sessions/basename; иначе SESSION. Заменить только sessionPath на destination/data/sessions/basename; записать JSON.stringify(state)0600 без добавочного LF.
5. Повторно проверить отсутствие destination; если появился — INPUT. Rename stage→destination является commit копии; chmod destination0700. В finally rm stage recursive force. fsync tree/parent и lock назначения в этом контракте не выполняются.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| INPUT | SetupIssue | Каталог назначения… / Во время импорта создан… | Путь/существование |
| RUNNING | SetupIssue | Перед переносом останови старого бота… | Живой source |
| FILE | SetupIssue | …символические ссылки… / неподдерживаемый тип файла | Неподдерживаемые данные |
| SESSION | SetupIssue | В копии отсутствует сохранённая Pi-сессия… | Потеря памяти при импорте запрещена |
| RESOURCE | rejected Promise | fs/JSON/normalization error | Копия не подтверждена |
