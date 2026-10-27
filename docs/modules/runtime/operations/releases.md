# Подготовка, проверка и сборка мусора выпуска

## Метод

`ReleaseStore.initialize/diskAvailable/prepare/validate/collect`, `runInstaller`, `inspectArchive`.

## Описание

Создать изолированную проверенную копию npm-пакета до остановки работающего worker.

## Ресурсы

[Release files](../database/README.md), [manifest](manifest.md), [storage](storage.md), [version HTTP](../http/version.md), [archive HTTP](../http/archive.md), npm и Node subprocess.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| version | stable semver | prepare: да | Точная версия |
| signal | AbortSignal | нет | Отмена подготовки |
| release | PublicRelease | validate: да | Проверяемый descriptor |
| protectedDescriptors | (PublicRelease\|path)[] | collect: нет | Защищённые от удаления пути; default [] |
| archive | Buffer | inspectArchive: да | gzip tar |
| maximumUnpackedBytes | bytes | нет | 500 MiB |
| command,args,cwd,env,timeout | subprocess параметры | runInstaller | Абсолютный исполняемый файл; timeout default 180000 ms |

## Выходные параметры

prepare/validate должны возвращать PublicRelease; diskAvailable — bavail*bsize в байтах; collect — `{removed:string[],errors:{path,reason}[]}`; runInstaller — объединённый stdout/stderr; initialize/inspectArchive — void.

## Результат в случае успеха

Завершённый выпуск должен находиться в releases с COMPLETE, полным инвентарём и синхронизированным деревом. Подготовка не должна изменять active/previous или учебное состояние.

## Результат в случае ошибки

Незавершённый stage должен удаляться, кроме случая retainStaging из неподтверждённо остановленной группы installer. Ошибка должна передаваться supervisor для backoff. Автоматических сетевых повторов внутри prepare нет.

## Алгоритм работы

1. initialize должен проверить safePath и privateDirectory последовательно для home, runtime, releases, staging. Конструктор должен требовать абсолютные home/npm/node и допустимый registry из [settings](../settings.md).
2. prepare должен требовать stable version, initialize и проверку abort; получить [метаданные](../http/version.md). Сформировать id `version + '-' + sha256(Buffer.from(integrity)).slice(0,24)` и releasePath.
3. Прочитать release.json с fallback null. Если существует, требовать совпадения version/integrity и выполнить validate; завершить его результатом. Если отсутствует, statfs(runtime) должен дать >=750 MiB свободного места; иначе PREPARE.
4. Создать staging UUID privateDirectory. Загрузить [архив](../http/archive.md), сравнить SHA-512 с SRI через timingSafeEqual; затем inspectArchive:
   1. Читать gunzip stream, накопленный размер должен быть <=500 MiB. Разбирать 512-байтные tar headers; нулевые headers пропускать, payload пропускать с округлением размера до 512.
   2. size должен быть octal string, safe integer, <=min(maximumUnpackedBytes,64 MiB). Имя без завершающего slash должно равняться package либо начинаться package/; запрещены `.`/`..` компоненты и backslash.
   3. Разрешить type '', '0', '2', '5'; запретить hardlink '1' и extensions. Symlink target должен быть относительным и после posix-normalize оставаться в package. Незавершённый header/payload в конце — ARCHIVE. Потоки закрыть в finally.
5. Записать release.tgz wx/0600; создать installation, npm-home, tmp, npm-cache 0700 и пустые empty-npmrc/empty-global-npmrc 0600. Запустить npm с `install --global --prefix <installation> <tgz> --omit=dev --ignore-scripts --no-audit --no-fund --registry=<registry>`.
   1. Среда должна содержать только PATH=`dirname(node):dirname(npm):/usr/bin:/bin`, HOME=stage/npm-home, TMPDIR=stage/tmp, npm_config_cache/userconfig/globalconfig из stage, registry, ignore_scripts=true, audit=false, fund=false, fetch_retries=0, fetch_timeout=timeout, update_notifier=false, yes=true, CI=true.
6. Проверить packageRoot safePath, name/version/engines package.json против metadata; assertManifest(runtime-manifest.json). Проверить inventory кроме пакетов @esbuild другой платформы. Для каждого применимого dependency прочитать package.json и сверить name/version.
7. Проверить SHA-256 esbuild/install.js. Выполнить Node transform TypeScript через require('esbuild') и stop; requiresBootstrap должен быть true при несовпадении hash bin/esbuild либо при ошибке transform, кроме abort/retainStaging, которые сразу завершают подготовку.
8. Если requiresBootstrap и bootstrap=false — PREPARE; иначе запустить проверенный install.js. Повторно проверить исходный inventory кроме esbuild/bin/esbuild и esbuild/lib/downloaded-*. Найти platform binary сначала в @esbuild/<platform>/bin/esbuild, затем lib/downloaded-@esbuild-<platform>-esbuild; требовать ожидаемый hash обоих найденного binary и bin/esbuild. Повторить transform; выполнить отдельный Node import Pi dist/index.js.
9. Проверить abort, сформировать descriptor по [database](../database/README.md) с inventoryTree(installation), синхронизировать installation, проверить abort, atomicJSON release.json. Создать COMPLETE wx/0600, записать checksum descriptor+LF, sync/close.
10. Удалить release.tgz, npm-home, tmp, npm-cache, оба npmrc; sync stage; проверить abort; rename stage→releasePath; sync releases. Вернуть PublicRelease. В finally удалить stage, если retainStaging не установлен.
11. validate должен initialize, проверить stable version и canonical base64 SHA-512 SRI; вычислить ожидаемый releasePath и требовать совпадения resolve(releasePath). Проверить safePath, release.json, regular non-symlink COMPLETE и checksum; сверить format/version/integrity/releasePath/packageRoot/platform. Затем assertManifest, safePath packageRoot, verifyInventory(installation,recorded.inventory,{exact:true}); вернуть PublicRelease из записанного descriptor.
12. collect должен initialize, привести защищённые пути к absolute Set; пройти entries releases. Защищённые пропустить. Не-directory, symlink и имена вне `\d+\.\d+\.\d+-[a-f0-9]{24}` оставить с reason `unrecognized release entry retained`. Остальные safePath и rm recursive force; успех добавить в removed, ошибку — errors reason `release cleanup failed`. Неизвестные записи и staging не удалять.

### Выполнение subprocess

1. runInstaller должен проверить abort, абсолютность command и X_OK, снова abort; spawn detached=true, stdin ignore, stdout/stderr pipe.
2. При abort, timeout или суммарном output >1 MiB запомнить первую причину и послать SIGTERM группе `-pid`; проверять необходимость SIGKILL каждые 20 ms, вооружив таймер 2000 ms после первой причины.
3. Дождаться close/error, снять таймеры/abort handler. Если группа ещё существует либо probe не подтвердил ESRCH, послать SIGTERM, ждать 100 ms, затем при необходимости SIGKILL и ещё 100 ms. Если группа всё ещё не подтверждена остановленной — INSTALLER с retainStaging=true.
4. Затем бросить первую причину остановки; иначе spawn error преобразовать в сообщение с code; ненулевой close code/signal преобразовать в INSTALLER без вывода захваченного output. Только code=0 должен вернуть output.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| PREPARE | rejected Promise | release metadata/identity/bootstrap/disk… | Ошибка подготовки или проверок |
| ARCHIVE | rejected Promise | archive… / truncated release archive | Недопустимый gzip tar |
| INSTALLER | rejected Promise | release installer… / installer descendants… | Запуск, timeout, output, exit или группа процессов |
| CANCEL | AbortError | release preparation cancelled | Отмена до публикации |
| RESOURCE | rejected Promise | fs/JSON/inventory error | Ошибки ресурсов и validate |
