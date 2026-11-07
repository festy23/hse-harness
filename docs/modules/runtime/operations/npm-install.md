# Согласованная глобальная npm-установка

## Метод

`grantTelegramUpdate(home,id)`, `restoreTelegramUpdatePermission(home,id)`, `installApprovedPackage({home,version,integrity,signal})`, `updateRuntime(home,managed)`.

## Описание

Установить одобренную владельцем точную идентичность пакета и разрешить её применение supervisor.

## Ресурсы

[settings/journal](../database/README.md), [release store](releases.md), [installation settings](installation.md), глобальный npm prefix, temporary npm configs.

## Входные параметры

home — личный каталог; id — request UUID; version/integrity — одобренные значения; signal — AbortSignal установки; managed — режим worker.

## Выходные параметры

grant/restore/install — void. updateRuntime должен вернуть адаптер с snapshot/grant/restore/install. snapshot unmanaged или без home должен вернуть undefined.

## Результат в случае успеха

Глобальный package.json должен иметь version. Это не подтверждает переключение работающего worker; его подтверждает стабильный runtime snapshot после probation.

## Результат в случае ошибки

Ошибка должна распространяться до TelegramUpdates. Изолированный target может остаться в releases. Откат частично изменённой глобальной npm-установки не выполняется.

## Алгоритм работы

1. grant под settings.lock должен прочитать settings fallback enabled true. Только если enabled===false установить true и telegramUpdatePermission=id, atomicJSON. restore под тем же lock должен только при совпадении permission=id поставить enabled=false, удалить marker и atomicJSON. Иная явная CLI policy должна сохраняться.
2. install должен требовать stable version и SRI regex, прочитать journal. installation.manifestPath должен resolve и оканчиваться `/lib/node_modules/@ivan-boss/hse-harness/package.json`; вывести prefix удалением suffix. Иной layout — INSTALL.
3. findNpm, ReleaseStore(home,node=process.execPath,npm), prepare(version,signal); требовать target.integrity=одобренному integrity; compatible(active,target) и journal.supervisorVersion>=target.manifest.minSupervisorVersion.
4. Прочитать глобальный package.json; только ENOENT разрешает version=journal.installedVersion??active.version. Требовать stable current.version и current.version<=version. settings.enabled===false — INSTALL.
5. Если current.version===version, при quarantine этой версии или manualHold этой версии записать requestUpdate(retry); затем завершить без npm. Иначе создать runtime/.telegram-install-*; записать пустые user.npmrc/global.npmrc0600.
6. runInstaller npm должен получить `install --global --prefix <prefix> @ivan-boss/hse-harness@<version> --omit=dev --ignore-scripts --engine-strict --no-audit --no-fund --loglevel=error --registry=https://registry.npmjs.org/ --userconfig=<file> --globalconfig=<file> --cache=<scratch/cache> --fetch-retries=0 --fetch-timeout=120000`, cwd=scratch, timeout300000, signal.
7. Env должен содержать PATH из dirname Node/npm и /usr/bin:/bin, HOME process.env.HOME и только присутствующие proxy/TLS переменные `HTTP_PROXY,HTTPS_PROXY,NO_PROXY,http_proxy,https_proxy,no_proxy,NODE_USE_ENV_PROXY,SSL_CERT_FILE,NODE_EXTRA_CA_CERTS`. Прочие credentials не наследовать.
8. Прочитать глобальный manifest и требовать version. В finally rm scratch recursive force. Повторы npm отсутствуют.
9. snapshot должен прочитать state/settings и installation.manifestPath; ENOENT manifest использует installedVersion??active.version. quarantine должен быть массивом. Формировать поля таблицы. grant/install без home — INSTALL; restore без home — no-op.

| Поле snapshot | Правило |
|---|---|
| runningVersion | requiredString(HSE_RELEASE_VERSION ?? state.runningVersion ?? active.version) |
| installedVersion | requiredString(pkg.version) |
| updatesEnabled | settings.enabled !== false |
| stable | !state.attempt && active.version === (HSE_RELEASE_VERSION ?? state.runningVersion) |
| quarantined | version каждой quarantine записи, исходный порядок |
| retryPending | settings.request.action=retry и request.id!=state.lastRequestId |
| deferredReason | undefined при null/отсутствии, иначе requiredString |

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| INSTALL | rejected Promise | Invalid update identity / permanent global npm installation / integrity changed / serviced runtime upgrade / newer package / disabled / Managed runtime required | Проверки до внешнего изменения |
| RESOURCE | rejected Promise | fs/JSON/npm/prepare error | Неуспешная установка или чтение snapshot |
