# Переключение, откат и восстановление

## Метод

Supervisor.switchTo(target,manual=false), drain, finishWorker, stopInactive, rollback(error,{quarantine=true}), commit, recover.

## Описание

Передать право работы одному совместимому выпуску с ограниченной проверкой кандидата и сохранением последних учебных данных.

## Ресурсы

[Journal](../database/README.md), [IPC](ipc.md), [release validation](releases.md), [совместимость](manifest.md), [worker state](../../core/database/README.md), settings, notices.

## Входные параметры

target — PublicRelease; manual — признак явного rollback; error — причина отказа; quarantine — запретить автоматическое повторение ошибочного target. Бюджеты определяются [settings](../settings.md).

## Выходные параметры

switchTo/drain/stopInactive должны возвращать boolean продолжения; прочие — void. Ожидаемые отложенные переходы должны фиксироваться в journal.

## Результат в случае успеха

Только подтверждённо вышедший прежний worker допускает запуск следующего. До commit active должен оставаться прежним выпуском; probation worker может записывать новые учебные данные. Commit должен выбирать candidate, previous=from, сохраняя данные.

## Результат в случае ошибки

Rollback должен выбирать старый исполняемый выпуск поверх текущих данных. Snapshot restore учебного состояния не выполняется. Если выход/возобновление worker не подтверждён, второй worker запрещён.

## Алгоритм работы

### Drain и остановка

1. drain при отсутствующем/вышедшем worker должен вернуть true. Иначе command drain→quiescent; успех устанавливает mode quiescent и true.
2. При ошибке drain и уже вышедшем worker вернуть true. Для живого worker послать resume→active с bootMs. Ошибка resume устанавливает blocked=true и завершает CONTROL.
3. Успешный resume должен вернуть mode active, установить deferredReason `Текущая операция ещё выполняется; обновление отложено`, retryAt=Date.now()+deferMs, сохранить notice id `defer:<attempt.id>`; вернуть false. Не отправлять finish/SIGTERM в этой ветви.
4. finishWorker при живом worker должен send finish, mode exiting и ждать exit finishMs. Timeout должен установить blocked=true и завершить CONTROL; новый worker не запускать.
5. stopInactive должен учитывать activationRequested. Если true, потенциально активный worker должен пройти drain и finish; mode exiting — только waitExit. Если drain отложен — false. Если activationRequested отсутствует, допустим SIGTERM с ожиданием finishMs; неподтверждённый exit — blocked и CONTROL. Потеря active ACK не разрешает считать worker неактивным.

### Switch

1. Проверить compatible(active,target). Прочитать `<STUDY_DATA_DIR ?? home/data>/operations.json` fallback null, предел128 MiB. Если файл существует, его schemaVersion??1 должен входить в readableStateVersions обоих выпусков; иначе COMPATIBILITY.
2. Создать и save attempt: id UUID, from=state.active, to=target, phase draining, startedAt ISO, три счётчика=0, manual. Присвоить живому worker новый attemptId.
3. Выполнить drain. При false записать attempt.phase deferred, save, вернуть false. При stopping вернуть false с сохранённой attempt.
4. Для автоматического switch прочитать settings и installed; если !enabled либо installed!=target.version, resume→active, mode active, attempt=null, save, false.
5. Записать old-exiting, save; finishWorker; при stopping false. Записать starting, увеличить candidateStartCount, save.
6. До запуска автоматического кандидата ещё раз проверить settings.enabled. Если выключено, rollback с quarantine=false, вернуть false. Иначе startWorker(target,attempt.id,shouldActivate), где shouldActivate разрешает manual либо settings.enabled!==false.
7. При успешной активации установить activationObserved=true, phase probation, deferredReason=null. Для manual записать manualHold={...from,reason:'manual-rollback',createdAt:ISO}; save; true.
8. При ошибке запуска, если !stopping, выполнить rollback(error,{quarantine:error.code!=='UPDATE_CANCELLED'}); вернуть false.

### Rollback

1. Без attempt бросить исходную ошибку. Иначе failure должен быть строкой detail(error), URL заменить [URL], обрезать до500; phase rolling-back; quarantineOnRollback=аргумент. При quarantine добавить `{version:to.version,integrity:to.integrity,reason:failure,createdAt:ISO}`, если такой identity ещё нет; save **до** остановки кандидата.
2. Живой mode active должен пройти drain; false завершает текущий rollback без запуска старого. Quiescent должен пройти finish. Прочий живой должен пройти stopInactive; false завершает текущую попытку.
3. При stopping завершить; иначе validate(from). Пока rollbackStartCount<3 и !stopping: увеличить счётчик и save до startWorker(from,attempt.id).
4. При успехе установить active=from, phase rolled-back, activeCrashCount=max(0,rollbackStartCount-1), deferredReason=`Откат: <failure>`, attempt=null; сохранить notice `rollback:<attempt.id>` с версиями и failure; завершить.
5. При ошибке заменить failure=detail(error), stopInactive; если отложено — завершить. Ждать retryMs[rollbackStartCount-1] с stop signal. После исчерпания установить blocked=true, state.phase=blocked, save.

### Commit

1. Прочитать settings. Если probation автоматическая и enabled=false, rollback с quarantine=false и завершить. Без probation завершить без изменений.
2. Установить previous=from, active=to, lastSuccessfulSwitch=ISO, phase committed, pendingVersion=null, activeCrashCount=0, attempt=null; сохранить notice `commit:<id>` с from/to и сообщением о сохранении памяти/очереди. Save notice является фиксацией выбора.
3. Только после сохранения collect([active,previous]); ошибку GC передать options.log с очищенным detail, не откатывать commit.

### Recovery

1. Если attempt.phase либо state.phase blocked, установить blocked=true и завершить без запуска.
2. Если attempt rolling-back или имеет failure, продолжить rollback с сохранённой quarantineOnRollback!==false.
3. Выбрать candidate=attempt.to только при activationObserved и phase probation/starting; иначе state.active. startWorker(candidate,attempt.id??UUID).
4. При candidate=to установить probation и activatedAt=clock заново. При запуске active очистить attempt, кроме manual deferred. Save.
5. Ошибка при stopping завершает восстановление; при имеющейся attempt вызывает rollback. Без attempt вызвать stopInactive, blocked=true, phase blocked, deferredReason=detail(error), save. Неподтверждённая активация по-прежнему должна использовать безопасный stopInactive.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| COMPATIBILITY | rejected Promise | Несовместимый формат… / Текущий формат… | До записи attempt |
| CONTROL | rejected Promise | Не удалось подтвердить отмену drain / …второй worker запрещён | Живой writer не передаётся другому процессу |
| RESOURCE | rejected Promise | fs/JSON/IPC/save/validate error | Ветка caller должна сохранить block либо rollback; journal crash recovery применим только к подтверждённым записям |
