# Запуск и сигналы процесса

## Метод

runningPid, ServiceControl.start, runProcess из CLI и scripts/process.mjs.

## Описание

Запустить worker либо managed launcher и передать завершение вызывающему терминалу.

## Ресурсы

service.lock, env, Config, npm build, Node child_process, [runtime installation](../../runtime/operations/installation.md), process signals.

## Входные параметры

runningPid(dir=dataDir()); ServiceControl(root=process.cwd(),runner=runProcess,pid=reader(root/data)); start(config,notify); runProcess(command,args,root).

## Выходные параметры

runningPid — number|undefined; start — `{kind:'already-running',pid}` либо `{kind:'stopped',code}`; runProcess — code.

## Результат в случае успеха

Живой PID должен исключать запуск второго экземпляра. Runner должен дождаться exit child.

## Результат в случае ошибки

Ошибка сборки должна запретить запуск. Неожиданные ошибки subprocess должны преобразовываться в безопасный SetupIssue CLI wrapper.

## Алгоритм работы

1. runningPid должен readFile(dir/service.lock); ENOENT→undefined, другая ошибка→PROCESS. Попытаться JSON.parse: number взять напрямую, record.pid преобразовать Number; при syntax error Number(raw). Не-safe/<=0→undefined. kill(pid,0): успех/EPERM→pid; ESRCH→undefined; прочая ошибка распространяется. PID probe не посылает завершающий signal.
2. start должен сначала pid(); если найден, вернуть already-running без build. Требовать config.ownerId и TELEGRAM_BOT_TOKEN; недостающие перечислить в SetupIssue.
3. compiled определяется import.meta.url.endsWith('.js'). Если false, runner(npm.cmd на win32, иначе npm,['run','build'],root); nonzero→BUILD без worker.
4. packageRoot определяется URL ../../ от service module. Если compiled и managedInstallation(packageRoot), запретить win32; notify подготовки; installRuntime({home:managedHome(),packageRoot,node:process.execPath}); notify запуска; runner(node,[launcher],home), вернуть stopped/code.
5. Иначе entry=packageRoot/dist/main.js для compiled либо root/dist/main.js; notify; runner(node,[entry],root), вернуть stopped/code.
6. scripts runProcess должен spawn(command,args,{cwd:root,stdio:'inherit',env:process.env,detached:platform!='win32'}). На SIGINT/SIGTERM переслать только первый signal: child.kill на Windows, kill(-pid,signal) на POSIX; если pid отсутствует, пересылку пропустить без фиксации interrupted. ESRCH игнорировать; иная ошибка — PROCESS и снять handlers.
7. Spawn error должен снять handlers и reject безопасной ошибкой Node/npm. Exit должен снять handlers и вернуть code??(SIGINT?130:SIGTERM?143:1). Wrapper CLI должен преобразовывать reject в SetupIssue(message).

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| PROCESS | SetupIssue | Не удалось проверить/запустить/передать остановку… | Файловое чтение или child process |
| CONFIG | SetupIssue | Запуск невозможен… | Нет owner/token |
| BUILD | SetupIssue | Сборка завершилась с ошибкой. Бот не запущен | Ненулевой build |
| PLATFORM | SetupIssue | Автоматическое применение… macOS/Linux | Managed Windows |
| RUNTIME | rejected Promise | installRuntime error | Проверенная копия не подготовлена |
