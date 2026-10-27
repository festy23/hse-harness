# Манифест и инвентарь выпуска

## Метод

`stableVersion`, `sha256`, `validateRelativePath`, `fileIdentity`, `inventoryTree`, `verifyInventory`, `assertManifest`, `compatible`, `compareVersions`.

## Описание

Определить пригодность выпуска для установленного runtime и совместного чтения учебного состояния.

## Ресурсы

Дерево пакета, runtime-manifest.json, [константы](../settings.md).

## Входные параметры

`version` должен быть точной стабильной semver-строкой по `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`. У TypeScript update helpers дополнительно должен действовать предел 64 символа. `manifest` — JSON; platform/arch/nodeVersion должны по умолчанию браться из process. `verifyInventory` должен принимать `exact=false`.

## Выходные параметры

assertManifest должен возвращать исходный manifest; compareVersions — -1/0/1 по BigInt-компонентам; compatible — boolean; sha256 — hex SHA-256 байтов. Формат identity определён в [database](../database/README.md).

## Результат в случае успеха

Манифест допускается к подготовке или запуску. compatible не заменяет полную проверку release descriptor.

## Результат в случае ошибки

Невалидный manifest/path/inventory должен отклонять Promise или выбрасывать Error до запуска worker. compatible должен вернуть false.

## Алгоритм работы

1. Требовать `format=1`, packageName `@ivan-boss/hse-harness`, manifest.version=version и stableVersion(version).
2. Требовать protocolVersion=1, stateSchemaVersion=2, piVersion='1.0.2'; minSupervisorVersion должен быть стабильным и <= 1.0.1.
3. Требовать writableStateVersion=2; readableStateVersions должен содержать 1 и 2. formats должен содержать `operations:2, approvals:1, calendar:1, auth:1, pi:'1.0.2'`.
4. Требовать manifest.engines.node строго `>=22.19.0`; actual Node major >=22, при major=22 minor>=19. platforms должен включать текущий platform-arch; разрешённые платформы — darwin-arm64, darwin-x64, linux-x64, linux-arm64.
5. Требовать esbuild.version='0.28.2', scriptSha256='612294e278914443bdcf81cb17f54afec34dbdd2ebd999a6ee187912320cc315'; esbuild.platforms[current] должен совпадать с таблицей ниже.
6. Требовать arrays dependencies/inventory. Для каждого dependency требовать безопасный относительный path с префиксом `node_modules/`, строковые name/version. Дополнительные поля manifest не удалять.
7. `validateRelativePath`: запретить пустую строку, backslash, абсолютный путь, NUL и пустые/`.`/`..` компоненты.
8. `fileIdentity`: проверить родительские компоненты path на symlink; для файла вернуть path/type/sha256/size/mode. Для symlink требовать относительный target и realpath внутри canonical root; вернуть path/type/target. Остальные типы — INVENTORY.
9. `inventoryTree`: пройти каталоги рекурсивно; читать identity файлов пакетами по 24; вернуть сортировку localeCompare по path. `verifyInventory` должен требовать непустой массив и уникальные path, пакетами по 24 сравнить type/hash/size/target/mode. При exact сравнить также количество и состав всех фактических не-directory путей.
10. `compatible(from,to)`: у обоих требовать manifest, protocol=1, stable release.version и minimumSupervisorVersion ?? minSupervisorVersion ?? '1.0.0' <=1.0.1. Затем требовать равенства stateSchemaVersion, piVersion, writableStateVersion и **JSON.stringify(formats)**; порядок ключей formats влияет на равенство.

| Платформа | SHA-256 esbuild binary |
|---|---|
| darwin-arm64 | 10b6243df618d374bb2d5c9cfbe7052e1405f6aa4e53a6164f11a91b9f2e1384 |
| darwin-x64 | 7fe5c9c905fff0a05d92db98929434ab4d3b6dd92d7a7688922db74380c75df3 |
| linux-x64 | e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100 |
| linux-arm64 | 90bd269553d258e80b19e3ccab4f98f0831f87442a2f056510ce24fd1b425fc2 |

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| MANIFEST | Error | invalid/incompatible/unsupported/unaudited release… | Нарушение шагов 1–6 |
| INVENTORY | Error | inventory… / runtime inventory mismatch… | Нарушение путей/файлов/состава |
| VERSION | Error | Нужна стабильная semver-версия / Ожидается стабильная версия npm | Невалидный аргумент сравнения |
