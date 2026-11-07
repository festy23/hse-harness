# Сборка и npm-поставка

## Контракт

Вход: checkout с package.json, package-lock.json, src, runtime и установленными bundled dependencies. Выход build — `dist`; prepack — нормализованные dependency binaries, собранный dist и проверенный runtime-manifest. Самостоятельной публикации эти команды не выполняют.

## Ресурсы

[Артефакты](../database/README.md), [настройки](../settings.md), npm pack inventory, [runtime manifest](../../runtime/README.md), Node filesystem/crypto и TypeScript.

## Алгоритм работы

1. Build запускает `tsc -p tsconfig.json` с rootDir=src, outDir=dist. При ошибке остановить цепочку; предварительной очистки dist нет.
2. Prepack выполняет prepare-bundle → build → create-runtime-manifest → verify-package, прекращая выполнение на первом ненулевом результате. PrepublishOnly до публикации выполняет check и test:e2e. Npm определяет порядок lifecycle hooks; скрипты не реализуют отдельный rollback.

### Подготовка проверки архивной поставки

`npm run test:package` должен выполнять build → prepare-bundle → create-runtime-manifest → `node --test test/package.test.mjs`. В отличие от prepack, build здесь предшествует нормализации bin, а отдельный verify-package в этой цепочке отсутствует. Неуспех любого шага должен прерывать цепочку.

Внутренний npm pack проверки должен использовать `--ignore-scripts`, поэтому повторно prepack не запускается. При заданном `HSE_PACKAGE_ARCHIVE` npm pack должен получить этот архив дополнительным аргументом; без него должен упаковываться текущий checkout. Cross-OS шаг CI при этом по-прежнему сначала выполняет локальные build/prepare/manifest, а проверяет переданный Linux archive.

### Нормализация bundled bin

1. Прочитать package-lock; перебрать packages в порядке Object.entries. Обрабатывать только записи с inBundle и bin. Строковый bin становится массивом из одного пути, объектный — Object.values.
2. Разрешить путь относительно root/location; требовать префикс `<root>/node_modules/`. При выходе за границу завершить ошибкой. Lstat ENOENT означает пропуск; другую ошибку передать.
3. Если объект не symlink и nlink≤1, оставить его без изменения. Иначе прочитать content, записать соседний `<file>.hse-pack-<UUID>` с flag wx и mode 0755, rename поверх исходного bin, увеличить счётчик.
4. В finally удалить временный файл; ENOENT игнорировать, другую ошибку передать. Вернуть число нормализованных файлов через stdout. Уже нормализованные файлы при дальнейшей ошибке не восстанавливать.

### Создание manifest

1. Прочитать metadata/lock. Потребовать package name из runtime PACKAGE_NAME и stableVersion(metadata.version). Иначе завершить ошибкой.
2. Запустить npm `pack --dry-run --json --ignore-scripts` в root, maxBuffer 40 MiB. Ненулевой status — ошибка inventory. Timeout и автоматический retry не заданы. Взять первый объект результата массива либо Object.values.
3. Отобрать files с префиксами dist/, runtime/, bin/, node_modules/ либо точным scripts/process.mjs или package.json. Для каждого вычислить fileIdentity по runtime-контракту; обрабатывать партии по 24 параллельных чтения. Для regular file заменить mode значением npm inventory.
4. Найти locations всех `*/package.json`, устранить дубли и сортировать. Для location, присутствующих в lock.packages, прочитать actual package; потребовать совпадение version, добавить dependency record. Location без lock entry пропустить. Для каждого metadata.bundleDependencies потребовать record `node_modules/<name>`.
5. Прочитать esbuild package и install.js. Потребовать точную version и SHA-256 скрипта из ESBUILD_POLICY. Несовпадение завершает создание manifest; самостоятельного обновления policy нет.
6. Записать runtime-manifest.json как JSON + LF с mode 0644 по таблице. Запись обычная, без atomic rename/fsync или общей транзакции с dist.

| Поле manifest | Источник |
|---|---|
| format | 1 |
| packageName, protocolVersion, minSupervisorVersion, stateSchemaVersion | PACKAGE_NAME, PROTOCOL_VERSION, SUPERVISOR_VERSION, STATE_SCHEMA_VERSION из runtime |
| version, engines | metadata.version, metadata.engines |
| readableStateVersions, writableStateVersion | [1,2], 2 |
| formats | operations=2, approvals=1, calendar=1, auth=1, pi=PI_VERSION |
| piVersion | PI_VERSION |
| platforms, esbuild | Object.keys(ESBUILD_POLICY.platforms), ESBUILD_POLICY |
| dependencies | Сортированные records `{path:location, name:actual.name, version:actual.version}` |
| inventory | fileIdentity в порядке отфильтрованного npm inventory |

### Проверка пакета

1. Потребовать metadata.name=`@ivan-boss/hse-harness` и falsy metadata.private. Запустить npm pack dry-run/json/ignore-scripts с maxBuffer 32 MiB; ненулевой status — ошибка, retry/timeout не заданы.
2. Для first-party путей, не начинающихся `node_modules/`, запретить компоненты data, secrets, node_modules, src, test, .git; запретить `.env` и `.env.*`, кроме корневого `.env.example`; запретить filenames config.local.json, operations.json, telegram.session, pi-auth.json, google.json.
3. Потребовать bin/hse-harness.mjs, dist/cli.js, dist/main.js, dist/cli/system-service.js, dist/cli/import-installation.js, scripts/process.mjs, runtime/supervisor.mjs, runtime/installation.mjs, runtime/releases.mjs, runtime-manifest.json, docs/research/hse-software-engineering-bpi243.md, package.json bundled pi-coding-agent и pi-codemode.
4. Для каждого bundled node_modules package.json с соответствующим lock entry сравнить version. Несовпадение — ошибка. При успехе вывести число inventory files и сообщение об исключении локальных данных. Проверка основана на перечисленных путях и versions; содержимое произвольного документа не сканируется на секреты.
5. `npm pack` формирует tarball по metadata.files и правилам npm. В files включены bin, dist, scripts/process.mjs, docs, CONTEXT.md, deploy, config.example.json, .env.example, runtime и manifest, а runtime-зависимости перечислены в bundleDependencies.

## Ошибки

Ошибки JSON/filesystem/npm/TypeScript, неверный package name/version, dependency drift, отсутствующие обязательные файлы и несовпадение esbuild policy завершают команду ненулевым кодом. Автоматического повтора и rollback ранее записанных артефактов нет.

Источники: [package.json](../../../../package.json), [prepare-bundle](../../../../scripts/prepare-bundle.mjs), [manifest generator](../../../../scripts/create-runtime-manifest.mjs), [verify-package](../../../../scripts/verify-package.mjs).
