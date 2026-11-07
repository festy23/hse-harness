# Файловое состояние Runtime

## Размещение и писатели

Все пути должны разрешаться относительно абсолютного `home/runtime`. PostgreSQL, Redis и SQL-схема отсутствуют. Файлы JSON должны записываться через [atomicJSON](../operations/storage.md). Удаление учебных `data` и `secrets` не входит в runtime GC.

| Путь | Формат и назначение | Писатели |
|---|---|---|
| `state.json` | JSON runtime journal, схема ниже | installRuntime; единственный supervisor |
| `settings.json` | JSON политики и команды владельца | updateSettings, requestUpdate, grant/restore под settings.lock |
| `installation.lock` | Ownership record | installRuntime |
| `settings.lock` | Ownership record | операции изменения settings |
| `supervisor.lock` | Ownership record | Supervisor.run на весь срок жизни |
| `engines/<version>-<hash16>/*.mjs` | Проверенная копия отсортированных runtime `.mjs`; hash16 — первые 16 hex SHA-256 конкатенации имени и байтов каждого файла | installRuntime; существующий файл допускается только с теми же байтами |
| `launcher.mjs` | Исполняемый JS, импортирующий конкретный engine supervisor | installRuntime через временный файл и rename |
| `releases/<version>-<hash24>/` | Завершённый выпуск; hash24 — первые 24 hex SHA-256 UTF-8 строки integrity | ReleaseStore.prepare; удаление collect |
| `staging/<UUID>/` | Временная изолированная npm-установка | ReleaseStore.prepare |
| `.telegram-install-<random>/` | Временные пустые npmrc и npm cache | installApprovedPackage |

Каталоги runtime должны иметь mode `0700`; JSON и секретные временные файлы — `0600`; launcher — `0700`. Владение UID и отсутствие symlink должны проверяться в точках [storage](../operations/storage.md).

## Runtime journal

| Поле | Тип / формирование |
|---|---|
| `schemaVersion` | `1` |
| `supervisorVersion`, `protocolVersion` | `'1.0.1'`, `1` |
| `installation` | `{packageName:'@ivan-boss/hse-harness',manifestPath:string,registry:'https://registry.npmjs.org/',node:absolutePath,npm:absolutePath}` |
| `active` | PublicRelease текущего подтверждённого выпуска |
| `previous` | PublicRelease предыдущего подтверждённого выпуска либо null |
| `attempt` | Attempt либо null |
| `quarantine` | Массив `{version,integrity,reason,createdAt}`; уникальность по `version:integrity` при добавлении |
| `phase` | `installed`, `idle`, `preparing`, `deferred`, `committed`, `rolled-back`, `recovering`, `blocked` |
| `runningVersion`, `workerId` | Версия/UUID живого child либо null |
| `installedVersion` | Версия наблюдаемого глобального package.json либо null |
| `supervisorPid`, `supervisorOwnerId` | PID живого supervisor либо null; ownerId его lock |
| `updatesEnabled` | settings.enabled !== false |
| `updatedAt` | ISO текущего времени при save |
| `nextRetryAt`, `preparationRetryCount` | epoch ms следующей попытки; счётчик ошибок подготовки |
| `pendingVersion` | Ожидаемая версия либо null; может отсутствовать до первой подготовки |
| `deferredReason` | Причина ожидания/отката либо null; может отсутствовать |
| `activeCrashCount` | Число аварий текущего выпуска; исходно отсутствует и трактуется как 0 |
| `lastSuccessfulSwitch` | ISO времени commit; отсутствует до первого commit |
| `manualHold` | PublicRelease дополненный `{reason:'manual-rollback',createdAt:ISO}` либо null/отсутствует |
| `lastRequestId` | UUID последней потреблённой команды settings; отсутствует до команды |
| `notices` | До 50 `{id:string,text:string}` в порядке добавления; отсутствующий массив трактуется как пустой |

`Attempt` должен содержать `id:UUID`, `from:PublicRelease`, `to:PublicRelease`, `phase`, `startedAt:ISO`, `candidateStartCount`, `candidateFatalCount`, `rollbackStartCount`, `manual:boolean`. Фаза должна принимать `draining`, `deferred`, `old-exiting`, `starting`, `probation`, `rolling-back`; восстановление также должно учитывать сохранённую `blocked`. Поля `activationObserved:true`, `failure:string`, `quarantineOnRollback:boolean` должны добавляться соответствующими переходами. Счётчики должны сохраняться до запуска child и между перезапусками supervisor.

## Settings

| Поле | Правило |
|---|---|
| `enabled` | boolean; при отсутствии файла `{enabled:true}` |
| `request` | Необязательный `{id:UUID,action:'retry'|'rollback',createdAt:ISO}`; новая команда заменяет прежнюю |
| `telegramUpdatePermission` | Необязательный ID запроса, временно включившего disabled runtime |

Неизвестные поля settings должны сохраняться spread-обновлением. Явный enable/disable должен удалять `telegramUpdatePermission`; обработка request должна хранить подтверждение в `state.lastRequestId`, не удаляя request из settings.

## Release descriptor

`release.json` должен содержать `format:1`, `version`, `integrity`, полный `manifest`, абсолютные `releasePath`, `packageRoot`, `platform:'<platform>-<arch>'`, `inventory`, `preparedAt:ISO`. `packageRoot` должен быть `<releasePath>/installation/lib/node_modules/@ivan-boss/hse-harness`. `inventory` должен описывать всё `installation`. `COMPLETE` должен содержать SHA-256 от `JSON.stringify(descriptor)` и LF. PublicRelease должен исключать верхнеуровневый inventory и manifest.inventory, сохраняя прочие поля descriptor. Полный manifest и инвентарь должны читаться с диска при validate.

Обычная inventory-запись: `{path,type:'file',sha256,size,mode}`; symlink-запись: `{path,type:'symlink',target}`. Размер — байты, mode — младшие 9 бит. Manifest определяется в [контракте манифеста](../operations/manifest.md).

## Ownership record

Record должен содержать поля identity вызывающего, затем `pid:process.pid`, `ownerId:UUID`, `createdAt:ISO`. При восстановлении прежний lock должен переименовываться в `<lock>.stale-<UUID>`; `<lock>.recovery` должен ограничивать одновременно восстанавливающего писателя. Срок автоматического истечения отсутствует.

## Telegram update state

`npmUpdates` должен храниться внутри [Core State](../../core/database/README.md), а не в runtime journal. Его поля должны быть: `botIdentity?`, `latest?:{version,integrity}`, `checkedAt?:epochMs`, `offer?:{version,integrity,id}`, `lastOfferedAt?:epochMs`, `pendingNotice?:{id,text,offerId,version}`, `request?:{version,integrity,id,workerId,phase,created}`. Фазы request: `authorizing`, `pending`, `installing`, `awaiting-apply`, `completed`, `failed`. Offer.id является ID кнопки; request.id является отдельным UUID попытки. Поле created должно быть epoch ms.
