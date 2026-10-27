# Цикл Supervisor

## Описание

Наблюдать установленный npm-пакет, здоровье child и долговечные команды владельца.

## Запуск

`launcher.mjs` должен создать Supervisor(home).run. Цикл должен продолжаться до SIGINT/SIGTERM или fatal background failure, с паузой pollMs после tick.

## Входные параметры

home/options из [settings](../settings.md), [state/settings](../database/README.md).

## Результат

Штатная остановка должна сохранить null runningVersion/supervisorPid и освободить lock после выхода child. Fatal failure должен завершать run ошибкой. Неуспешный tick должен сохранять blocked; монитор остаётся доступен для retry.

## Ресурсы

supervisor.lock, runtime journal/settings, установленный package.json, [IPC](../operations/ipc.md), [switch/recovery](../operations/switch.md), [release preparation](../operations/releases.md), notices, process signals.

## Алгоритм работы

1. Создать runtime, взять supervisor.lock, зарегистрировать once SIGINT/SIGTERM. Прочитать state: schemaVersion=1, active и installation.manifestPath обязательны. Восстановить retryAt/retryCount, записать supervisorOwnerId из lock. Создать ReleaseStore с сохранённым npm. Если нет attempt, но phase preparing, заменить idle и pendingVersion=null. Выполнить recover.
2. На tick прочитать settings; установить updatesEnabled, installedVersion. Чтение установленного manifest должно возвращать undefined для ENOENT/EACCES/EPERM/SyntaxError, неверного package name либо нестабильной version; прочие ошибки — ошибка tick.
3. Если preparation существует и policy выключена, версия изменилась, появился непринятый settings.request либо stopping, пометить cancelled и abort. До settle сохранить preparation; после settle убрать, очистить pendingVersion, при отсутствии blocked/attempt поставить idle. Поздний target/error отменённой подготовки не должен применяться и не должен увеличивать backoff.
4. Для живого worker при `clock-lastHeartbeat > heartbeatMs` установить blocked, phase blocked, причину отсутствия ответа и save. Второй child не запускать.
5. Если settings.request.id!=lastRequestId и preparation отсутствует:
   1. retry: потребить id, снять manualHold только для installedVersion, удалить quarantine этой версии, сбросить blocked/retryAt/retryCount/activeCrashCount. При phase blocked и отсутствующем/вышедшем worker поставить recovering; существующую attempt перевести rolling-back и rollbackStartCount=0; recover. Для живого worker разрешить unblock только mode active и heartbeat age<=limit; тогда phase=attempt.phase??idle, deferredReason=null; иначе blocked=true.
   2. rollback при previous и отсутствии attempt: потребить id и switchTo(previous,true). При отсутствии previous потребить id и сохранить notice `request:<id>` о невозможности отката. При существующей attempt и previous команду оставить непотреблённой.
   3. Save, затем при stopping завершить tick.
6. При blocked, exited worker и attempt old-exiting снять blocked, phase recovering, retryAt=now+deferMs, save/recover и завершить tick. При прочем blocked завершить tick.
7. При rolling-back и now>=retryAt продолжить rollback с сохранённой failure/policy; завершить tick. При manual deferred и now>=retryAt повторить switchTo(to,true); завершить tick. Автоматическая probation с выключенной policy должна rollback без quarantine и завершить tick.
8. При exited worker:
   1. В probation, если worker.fatal, сразу rollback. Иначе увеличить candidateFatalCount/save; при >=3 rollback. При меньшем числе ждать retryMs[count-1]; если !stopping увеличить candidateStartCount/save и startWorker(to,id); ошибку запуска отправить в rollback.
   2. Без attempt либо с deferred увеличить activeCrashCount/save; при >=3 blocked, phase blocked и причина необходимости updates retry. Иначе ждать retryMs[count-1] и recover, если !stopping.
   3. Завершить tick; фоновая подготовка не препятствует восстановлению child.
9. В probation при `clock-activatedAt >= probationMs` выполнить commit; доставить notices, save, завершить tick. Для обычного active доставить notices; при той же границе probation сбросить activeCrashCount.
10. Если !settings.enabled, нет installedVersion, installedVersion<=active.version либо now<retryAt: save, завершить tick. Иначе обновить observed/observations; до debounce save и завершить.
11. При `0 < nextReminder-now <60000` сохранить причину `Сначала отправлю ближайшее напоминание`, save и завершить. При hold этой версии либо любой quarantine записи этой версии save и завершить.
12. Если preparation отсутствует, поставить phase preparing/pendingVersion, save и beginPreparation; завершить tick. Pending preparation — save и завершить. Завершённую снять; cancelled — завершить; failed — перейти к шагу 14.
13. Для ready проверить !stopping, свежую policy и installed==observed version; иначе phase idle/save/завершить. Проверить compatible, снять manualHold иной версии, switchTo(target), retryCount=0.
14. Ошибка шага12–13: deferredReason=detail(error), retryAt=now+[60000,300000,900000,3600000][min(retryCount++,3)]; если !blocked phase deferred; save. При !stopping notice `prepare:<version>:<detail>`; повтор идёт после backoff.
15. save должен обновлять supervisorVersion, supervisorPid, runningVersion, workerId, updatedAt, nextRetryAt, preparationRetryCount; клонировать state и последовательно дописывать Promise-цепочку atomicJSON. Notice должен дедуплицироваться по id, добавляться в конец и удалять старейшие записи сверх50 до save.
16. Ошибка tick должна устанавливать blocked/phase/deferredReason и save. requestStop должен однократно stopping=true, abort stopController, cancelPreparation и SIGTERM живому child.
17. После выхода цикла поднять backgroundFailure при наличии; ждать exit finishMs. При timeout бросить ошибку. В catch requestStop и повторно ждать exit; при неподтверждённом выходе сохранить lock/handlers и ждать worker.exit без создания замены. В finally отменить подготовку и дождаться её completion, снять signal handlers; release lock только когда child отсутствует либо exited.
