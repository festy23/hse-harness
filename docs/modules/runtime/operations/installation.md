# Установка runtime и настройки

## Метод

`installRuntime`, `startManaged`, `updateSettings`, `requestUpdate`, `readRuntimeStatus`, `findNpm`.

## Описание

Создать стабильный supervisor вне изменяемого глобального npm-каталога и предоставить управление политикой.

## Ресурсы

[Runtime files](../database/README.md), [storage](storage.md), [releases](releases.md), packageRoot/package.json, service.lock [Core](../../core/operations/locking.md).

## Входные параметры

installRuntime/startManaged: `{home,packageRoot,node?,npm?,releaseStore?}`; updateSettings: `(home,{enabled:boolean})`; requestUpdate: `(home,{action:'retry'|'rollback'})`; readRuntimeStatus: home. Внедрённый releaseStore должен предоставлять prepare, validate и npm.

## Выходные параметры

installRuntime должен возвращать `{launcher,active}`; startManaged — exit code; изменение settings — новый JSON объект. Статус должен содержать только поля таблицы ниже.

## Результат в случае успеха

Launcher и journal должны ссылаться на проверенный engine/active. Повторная установка должна сохранять прежний active, previous, attempt, quarantine, manualHold и policy.

## Результат в случае ошибки

При ошибке до записи journal прежний journal/launcher должны сохраняться. После journal commit ошибка launcher не должна откатывать уже записанный journal. Installation lock должен освобождаться в finally.

## Алгоритм работы

1. findNpm должен проверить npm_execpath, затем `<absolute PATH entry>/npm` в порядке PATH; пропускать не-absolute пути, выбирать первый X_OK. Отсутствие — INSTALL.
2. installRuntime должен resolve home/packageRoot; требовать platform darwin/linux и package.name `@ivan-boss/hse-harness`. Создать private home/runtime и взять installation.lock.
3. Прочитать supervisor.lock и `<STUDY_DATA_DIR ?? home/data>/service.lock`; отсутствующий lock — не работает. Числовой JSON либо record.pid должен быть safe integer >0; повреждение — INSTALL. `kill(pid,0)` с ESRCH означает остановку, успех — отказ установки, другие ошибки распространяются.
4. Прочитать state с fallback null; существующий schemaVersion должен быть 1. Подготовить release metadata.version. При old.active валидировать его и сохранить активным; иначе выбрать подготовленный выпуск. Engine всегда брать из вновь подготовленного установленного выпуска.
5. Прочитать отсортированные `.mjs` runtimeSource; требовать supervisor.mjs. Вычислить engine hash по [database](../database/README.md), создать directories, сравнить существующие файлы побайтно либо записать отсутствующие wx/0600; несоответствие — INSTALL. syncTree engine, sync engines.
6. Прочитать settings fallback enabled true и atomicJSON без изменения. Сформировать journal: spread old; заменить schemaVersion=1, supervisorVersion='1.0.1', protocolVersion=1, installation из package metadata/options/store; active из шага 4; previous/attempt default null, quarantine default []; phase default installed; runningVersion=null, installedVersion=metadata.version, supervisorPid=null, updatesEnabled=settings.enabled!==false. atomicJSON state является commit этой записи.
7. Создать временный launcher wx/0700: импорт node:url/node:path и конкретного engine, вычисление home из расположения launcher, HSE_HARNESS_HOME, new Supervisor(home).run; ошибки должны выводиться с URL→[URL] и process.exitCode=1. sync/close temp, safePath launcher, rename, chmod0700, sync root; вернуть launcher/active.
8. startManaged после installRuntime должен spawn Node [launcher], inherited env/stdio. Один SIGINT/SIGTERM должен пересылаться child, если !child.killed; обработчики удалить на error/exit. Вернуть code либо 130 для SIGINT, иначе 143 при null code.
9. updateSettings должен проверить boolean enabled, взять settings.lock, прочитать settings с fallback, заменить enabled, удалить telegramUpdatePermission, atomicJSON, вернуть settings, finally release. requestUpdate должен проверить action, под тем же lock заменить только request на `{id:UUID,action,createdAt:ISO}`, atomicJSON и вернуть settings.
10. readRuntimeStatus должен читать state fallback null и settings fallback; без state вернуть только updatesEnabled. При state попытаться прочитать installation.manifestPath, подавив ошибку версии; прочитать supervisor.lock и считать running только при совпадении ownerId со state.supervisorOwnerId и живом PID. Само чтение не создаёт runtime.

| Поле результата status | Источник или правило формирования |
|---|---|
| installedVersion | package.json.version либо undefined |
| runningVersion | state.runningVersion ?? undefined только при running |
| supervisorVersion | state.supervisorVersion |
| updatesEnabled | settings.enabled !== false |
| phase | state.attempt?.phase ?? state.phase |
| pendingVersion | state.attempt?.to?.version ?? state.pendingVersion |
| deferredReason, lastSuccessfulSwitch | одноимённые поля state |
| quarantine | map массива только `{version,reason}`, либо undefined |
| manualHold | только `{version}` при наличии hold |

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| INSTALL | rejected Promise | npm не найден / Неизвестный пакет / lock / runtime… | Предусловия или файлы установки |
| INPUT | rejected Promise | enabled должен быть boolean / Неизвестная команда updates | Некорректные настройки/команда |
| RESOURCE | rejected Promise | fs, lock, release preparation error | Изменение не подтверждено |
