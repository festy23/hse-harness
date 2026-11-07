# Управление обновлениями из CLI

## Метод

managedHome, managedInstallation, runtimeAPI, installedRuntimeStatus, formatRuntimeStatus, updatesCLI.

## Описание

Показать установленную/работающую версии и сохранить команду supervisor.

## Ресурсы

package.json CLI, [runtime installation API](../../runtime/operations/installation.md), env/npm layout.

## Входные параметры

updatesCLI args ровно одной команды status/enable/disable/retry/rollback; options overrides home/packageRoot/print/api/platform/env. RuntimeStatus допускает installedVersion/runningVersion/supervisorVersion/updatesEnabled/phase/pendingVersion/deferredReason/lastSuccessfulSwitch/quarantine/manualHold.

## Выходные параметры

updatesCLI —0 после успешного чтения/сохранения; installedRuntimeStatus — RuntimeStatus; formatRuntimeStatus — multiline string; managedInstallation —boolean; managedHome —absolute path; runtimeAPI —динамический импорт installation.mjs.

## Результат в случае успеха

enable/disable должны менять policy; retry/rollback должны только записывать request. Выполнение команды supervisor подтверждается последующим status.

## Результат в случае ошибки

Неверный layout/platform должен запрещать изменение. Read-only status должен оставаться доступным и не создавать runtime home.

## Алгоритм работы

1. managedHome=resolve(HSE_HARNESS_HOME||homedir/.hse-harness). managedInstallation должен вернуть false при npm_command='exec' либо компоненте пути `_npx`; иначе true только для resolve(packageRoot), оканчивающегося `lib/node_modules/@ivan-boss/hse-harness`.
2. updatesCLI проверить ровно1 допустимый action, затем home/print/api. Status должен installedRuntimeStatus(home,api), format/print,0 до проверки platform/layout.
3. installedRuntimeStatus должен readRuntimeStatus(home), прочитать собственный ../../package.json, вернуть spread runtime status с installedVersion=metadata.version. Это версия команды CLI, даже если journal содержит иной manifest path.
4. Для мутаций запретить platform win32 и !managedInstallation. enable/disable→api.updateSettings({enabled:action==='enable'}), вывести подтверждение. retry/rollback→api.requestUpdate({action}), вывести факт сохранения запроса. Не вызывать installRuntime из этих команд.
5. formatRuntimeStatus должен всегда включать installed version либо не определена, running либо бот остановлен, supervisor либо не установлен, automatic policy и phase либо режим ещё не установлен. При enabled и без supervisor вывести ожидание первоначального запуска, а не утверждение работающего supervisor.
6. Добавить pendingVersion/deferredReason только при truthy. ManualHold.version должен показывать запрет повторного применения и retry. Quarantine печатать только entries object со string version/reason. lastSuccessfulSwitch string вывести как есть; legacy object только при string from/to вывести стрелку. Прочие произвольные поля журнала не выводить.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| INPUT | SetupIssue | Использование: hse-harness updates… | Аргументы |
| PLATFORM | SetupIssue | …macOS/Linux… | Windows mutation |
| LAYOUT | SetupIssue | …постоянной npm-установки… | npx/dev/local layout |
| RESOURCE | rejected Promise | runtime/fs/JSON error | Чтение/сохранение |
