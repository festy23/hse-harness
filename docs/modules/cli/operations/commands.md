# Команды и интерактивное меню

## Метод

bin/hse-harness.mjs, src/cli.main, runCLI, src/setup entrypoint.

## Описание

Выбрать действие без неявной настройки внешних интеграций.

## Ресурсы

process.argv/env/exitCode, [SetupState](setup-state.md), [sections](sections.md), [terminal](terminal.md), [process](process.md), [runtime](updates.md).

## Входные параметры

args — массив строк без node/script. main default process.argv.slice(2). runCLI принимает Partial CLIDependencies.

## Выходные параметры

runCLI — integer exit code; main — void с process.exitCode. CLI stdout/stderr должны содержать результаты/диагностику, а не значения секретов.

## Результат в случае успеха

Команда должна вернуть0 либо код дочернего процесса. Интерактивная отмена должна сохранять завершённые разделы.

## Результат в случае ошибки

main должен печатать setupError и устанавливать exitCode1. Внутри меню ошибка раздела должна показываться и возвращать управление меню.

## Алгоритм работы

1. bin должен resolve HSE_HARNESS_HOME || ~/.hse-harness и установить его в env; resolve четыре пути из [settings](../settings.md), принимая существующее непустое значение либо default home/path. Требовать Node major>22 либо major22/minor>=19; иначе stderr и exitCode1 без dispatch.
2. Выполнить dispatch:

| args[0] | Проверка и действие |
|---|---|
| --version, -v | Прочитать package.json рядом с bin, вывести version; дополнительные args не проверяются |
| paths | Требовать ровно1 arg; вывести pretty JSON `{home,config,env,data,secrets}` из разрешённых путей |
| run | Требовать ровно1 arg; import dist/main.js без supervisor |
| service | serviceCLI(args.slice(1)); exitCode=результат |
| updates | updatesCLI(args.slice(1)); exitCode=результат |
| import | Ровно2 args; resolve source; importInstallation(source,home); вывести подтверждение |
| setup | main(['configure',...args.slice(1)]) |
| другое/отсутствует | main(args) |

3. Ошибки bin должны печатать Error.message либо общее сообщение, exitCode1. runCLI до создания SetupState должен обрабатывать help/--help/-h (вывести справку/0) и updates (делегировать); дополнительные args help не проверяются. Для остальных допустить отсутствие команды либо единственный start/status/telegram-chats/configure/profile/telegram/mail/model/calendars; неизвестная команда/args.length>1 — INPUT.
4. Создать/load SetupState, UI и ServiceControl; report=setupReport(state,service.pid()). start должен вернуть результат process contract; already-running выводит PID и возвращает0 для прямой команды. Ненулевой child code кроме130/143 дополнительно показать как failure. status должен показать report и runtime summary; сообщить о сохранённом характере данных. telegram-chats — [access report](status.md). Эти команды не требуют TTY.
5. Остальные действия должны требовать overrides.interactive??stdin.isTTY. Создать Onboarding; runSection должен state.prepare, flow.run(section), success. Весь раздел выполняется [транзакционно](setup-state.md).
6. Показать welcome/report; при живом PID сообщить о применении изменений после перезапуска. Прямая section должна выполниться и вывести finish/0. configure должен пройти sections в порядке profile,telegram,mail,model,calendars:
   1. Для каждого показать номер, получить свежую readiness, предложить edit/skip/menu. Initial=skip при ready, иначе edit.
   2. menu возвращает главное меню; skip переходит к следующему; edit запускает раздел. SetupCancelled внутри configure возвращает меню. По окончании показать report, finish/0 для прямой команды.
7. Главное меню должно на каждой итерации обновлять report. Пункты: configure, start, пять sections с telegram-chats после telegram, status, updates, exit. Initial=start, если completed==total, иначе configure. Exit должен finish/0. start с кодом завершает CLI; already-running остаётся в меню. status показывает текущий report; updates — summary; остальные делегируются.
8. SetupCancelled действия меню должен показать сообщение об отмене раздела и продолжить. Прочая ошибка действия — failure(setupError) и продолжить. SetupCancelled внешнего выбора/прямого раздела должен finish(cancelled=true) и0; прочая ошибка распространяется.
9. src/setup entrypoint для models должен directories(), modelRuntime(), subscriptionModels(), вывести `id — name` по строке; иначе алиасы pi→model, google/icloud/yandex→calendars и cli.main. src/onboarding должен переэкспортировать SetupState/upsertEnv/Onboarding/SetupIssue/SetupCancelled/Choice/SetupUI/SetupConnections без дополнительных эффектов.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| INPUT | SetupIssue / exit1 | Неизвестная команда / Использование… | Неверные аргументы |
| TTY | SetupIssue / exit1 | Открой интерактивный терминал… | Настройка без TTY |
| STEP | exit1 либо продолжение меню | setupError(error) | Ошибка зависимого действия |
