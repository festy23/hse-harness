# Worker приложения

## Описание

Worker собирает интеграции, допускает операции через lifecycle, выполняет фоновые циклы и завершает их перед освобождением writer lock.

## Запуск

`src/main.ts` запускается Node.js напрямую либо supervisor. Managed-режим включён только при наличии `HSE_WORKER_ID` и `process.send`.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| Конфигурация | Config | Да | [Настройки](../settings.md) |
| Managed IPC | Сообщения protocol 1 | Только managed | [Worker control](../operations/worker-control.md) |
| SIGINT, SIGTERM, disconnect | События процесса | Нет | Остановка; disconnect действует в managed-режиме |

## Результат

Остановка освобождает writer lock после завершения допущенных операций и checkpoint. Fatal-ошибка либо ошибка завершающего checkpoint устанавливает exit code 1. Обработанная nonfatal-ошибка sourceLoop, repeat или Pi сохраняет состояние `unavailable` и допускает последующий повтор. Для этих ветвей cancellation не меняет health, а deadline source operation имеет отдельное правило ниже. Необработанное отклонение любого loop, включая updates.tick(), прерывает Promise.all, запускает fail/stop и завершает worker с exit code 1; общего подавления внешних ошибок вокруг всех циклов нет.

## Ресурсы

[Состояние и очереди](../database/README.md), [конфигурация](../settings.md), [writer lock](../operations/locking.md), [lifecycle](../operations/worker-control.md), [бюджеты](../operations/budgets.md), [Pi](../../assistant/README.md), [бот](../../telegram-bot/README.md), [источники](../../sources/README.md), [календарь](../../calendar/README.md), [учебные операции](../../study/README.md), [обновления](../../runtime/README.md).

## Алгоритм работы

1. В managed-режиме дождаться prepare с protocol 1, своим workerId, строковым attemptId и целочисленным безопасным sequence. До него не загружать прикладное состояние.
2. Прочитать Config; загрузить Store с `readOnly: true`; получить processLock каталога данных. Ошибку передать как boot-failed `state-invariant` при наличии исходного prepare и завершить запуск с ошибкой.
3. Создать Bot, Scheduler, PiAssistant, TelegramSource, MailSource, Approvals и UpdateRuntime. TelegramSource и MailSource получают функцию допуска `lifecycle.accepting`; разрешённые вопросы ограничить чатами, у которых `allowQuestions !== false`.
4. Только в managed-режиме создать WorkerControl. Prepare не выполняет повторную загрузку. Activate вызывает `store.activateBot(bot.identity)` до разрешения ожидания активации. Checkpoint последовательно вызывает `store.flush()` и `pi.checkpoint()`. Действия notice, health, finish и transition задать по разделу «Действия IPC» ниже.
5. Зарегистрировать IPC и сигналы остановки. Ошибка обработки IPC вызывает fatal с `state-invariant` и stop. Stop устанавливает stopped, отменяет stop/source/update scopes с причиной stop, закрывает lifecycle, разблокирует ожидание активации, прерывает polling и активную сессию Pi. Ошибка abort Pi игнорируется.
6. В managed-режиме обработать начальный prepare и ждать activate; при stop завершиться. В прямом режиме активировать lifecycle и identity бота. Создать каталоги, календарь и Responsiveness. Для каждой записи `cursors['sourceProgress:'+name]` восстановить только lastSuccess и lastError; initialComplete начинает с false, continuing отсутствует до первой записи результата/operation deadline. Ошибку разбора сохранённого progress игнорировать; lastSuccess восстанавливать только для string, lastError — только при string at и kind. Установить health='starting' для Календарь, Telegram, Модель, Почта, Уведомления/календарь, Подтверждения и сохранить. Остальные прежние health keys этой инициализацией не сбрасывать.
7. Параллельно запустить циклы из таблицы. Каждый цикл ждёт active перед допуском своей операции через lifecycle. Корневые операции, запрещённые drain, не начинают работу. После завершения всех циклов повторно выбросить сохранённую IPC-ошибку, если она есть.

| Цикл | Действие | Пауза и бюджет |
|---|---|---|
| Bot | Проверить coordinator, продвинуть подтверждённый offset, получить updates, передать coordinator, снова продвинуть offset | После итерации 1 s; отдельный polling abort |
| Pi | Подключить модель и обработать одну запись queue по правилам ниже | Нет записи: 300 ms; ошибка подключения: 30 s; unavailable model после обработки: 30 s |
| Telegram | При пустом chats вернуть complete/initialComplete true; иначе connect, затем poll | Source budget: connect 120 s + slice 60 s |
| Почта | MailSource.poll | Source budget 120 s |
| Календарь | StudyCalendar.syncSchedule | Source budget 120 s |
| Notifications | localTimers по правилам ниже | Каждые 10 s, approval scope 120 s |
| Approvals | Параллельно recover и tick, дождаться обоих; выбросить fatal rejection, иначе первый rejection | Каждые 10 s, approval scope 120 s |
| TaskSync | recoverTaskOperations, затем Scheduler.refresh | Каждые pollSeconds, source scope 120 s |
| Npm update | UpdateRuntime.tick | Каждые 5 s; updateAbort |

### Действия IPC

1. notice(text,id) формирует key=`runtime:<id>`. При truthy delivered[key] завершить
   без записи. Иначе присвоить notices[key]=text и дождаться Store.save; фактическую
   доставку выполняет Scheduler.flushNotices. ACK notice-sent означает сохранение,
   а не квитанцию Telegram.
2. health возвращает `{integrations:state.health,nextReminder:scheduler.nextReminder(),backlog:state.queue.length}`.
3. transition(draining) прерывает текущий polling и отменяет sourceAbort с
   OperationError cancelled, message=`Приём источников приостановлен`, reason=drain.
   transition(active) заменяет sourceAbort новым AbortController только если прежний
   signal уже aborted. stopAbort не отменять при drain.
4. finish присваивает stopped=true, отменяет stopAbort с cancelled/stop
   `Сервис останавливается` и ждёт telegram.close. Остальную очистку выполняет
   основной finally.
5. IPC send при !process.connected, синхронной ошибке process.send либо ошибке его
   callback сохраняет первую ipcFailure=OperationError invariant
   `Worker IPC connection failed`, выставляет fatalExit=true и вызывает stop.
   Эти ошибки send обрабатывает через fail/stop и не пробрасывает синхронно.

### SourceLoop

1. Создать source operation с бюджетом цикла и sourceAbort. Вызвать poll. Установить `continuing = result.complete === false`, `initialComplete ||= result.initialComplete ?? result.complete !== false`, `lastSuccess = ISO(now)`.
2. Записать progress в `cursors['sourceProgress:'+name]` как JSON со всеми полями текущей progress-записи и дождаться save. Отметить компонент ok.
3. При fatal-ошибке завершить цикл с этой ошибкой. Только если op.signal.aborted и его reason — OperationError kind=deadline с reason=operation, установить continuing=true без save progress и без изменения health; deadline request без этих условий идёт в следующую ветвь. При другой non-cancelled ошибке записать lastError `{at: ISO(now), kind: OperationError.kind либо 'transport'}`, сохранить progress и health unavailable. При cancellation не изменять health.
4. Освободить operation. Подождать 1 s при continuing, иначе pollSeconds × 1000 ms, затем вернуться к ожиданию active. Пауза исчисляется после завершения операции.

### Очередь Pi

1. Если сессия не готова, перечитать model из конфигурации, вызвать openPi с connect budget 120 s, stopAbort, studyTools и profile. Установить ready=true и health model ok. Отправить startup сообщение с delivery ID `startup:<workerId либо pid>` и question budget 45 s; nonfatal-ошибка этого сообщения не отменяет готовность. При ошибке открытия dispose сессию, установить ready=false и health unavailable, подождать 30 s и начать заново.
2. Выбрать первую queue-запись с `ownerText !== undefined`; при отсутствии взять queue[0]. При отсутствии записи подождать 300 ms. Обработку найденной записи допустить через lifecycle.
3. Если digest достиг `date + hour + 2 h`, отметить его missed, удалить из queue и сохранить. Иначе выбрать prompt по truthy ownerText, затем truthy digest, иначе sources. Личный текст владельца получает owner authority; пересланный текст маркируется DATA без полномочий владельца; источник сериализуется как недоверенные DATA; digest запрашивает сводку. Для ownerText дополнительно передать состояние initial review и число queue entries с sources.length>0, а не полную длину очереди. Форматы prompt определены в [Assistant](../../assistant/README.md).
4. Установить pi.turnId=item.id. Для phase=answer использовать item.answer, иначе запросить completedTurn(id). Если ответа нет, установить phase=prompting, сохранить и вызвать `pi.prompt(context, Boolean(ownerText) && !forwarded)`.
5. Если digest ещё не имел phase=answer, повторно проверить его возраст после генерации: при возрасте ≥2 h отметить missed и удалить; при возрасте >120 s добавить префикс задержки. Сохранить phase=answer и answer до отправки.
6. При truthy ownerText либо digest и truthy answer вызвать Bot.send с delivery ID `answer:<id>`. Для обычного источника отдельный ответ не отправлять. Удалить все queue entries с этим id, для digest записать delivered[id]=now, сохранить и отметить model ok. При ошибке вызвать status('Модель',error); не откатывать уже выполненные мутации queue/phase/answer. До успешной доставки запись обычно остаётся в queue для повтора, но ошибка завершающего save после удаления не восстанавливает её в памяти; fatal-ошибка завершает цикл.

### Локальные таймеры и health

1. При bootstrapFinished параллельно выполнить Scheduler.tick(now, ctx) и Scheduler.digests; дождаться обоих, передать fatal rejection первым, иначе первый rejection. До bootstrapFinished выполнять только flushNotices.
2. Когда bootstrap не завершён, Pi ready, все три источника initialComplete, queue пуста и delivered.initialReview отсутствует, отправить запрос начальной сверки с delivery ID `initial-review`. После отправки записать delivered.initialReview=now и сохранить. BootstrapFinished меняется командой владельца, а не этим уведомлением.
3. Health изменять только при переходе между ok и unavailable. Fatal передавать вызывающему; stopped/cancelled не обновляют health. При unavailable добавить notice с ключом `health:<component>:<UUID>` и общей диагностикой. Для model разрешено дополнительно показать сообщение только с префиксом ошибки подписочного входа, отсутствующей модели или требования выбора модели. При восстановлении unavailable → ok добавить notice только после bootstrapFinished. Сохранить state и вывести timestamp/component/status в console.
4. Responsiveness измеряет event loop delay с resolution 20 ms, сбрасывает histogram раз в 60 s unref-таймером. Snapshot возвращает p95Ms и maxMs из nanoseconds с округлением до двух знаков, windowSeconds=60; close отключает histogram и таймер.

### Завершение и гарантии

1. В finally вызвать stop, закрыть WorkerControl и снять IPC handler. Дождаться allSettled фоновых циклов, coordinator.idle и lifecycle.idle, затем store.flush и pi.checkpoint. Ошибка checkpoint устанавливает exit code 1.
2. Закрыть TelegramSource и общий ComputeClient, игнорируя ошибки закрытия; dispose Pi, закрыть Responsiveness, удалить обработчики сигналов, освободить writer lock. Fatal устанавливает exit code 1.
3. Верхнеуровневая ошибка печатает причину незавершённого запуска с заменой HTTP URL на `[URL]`, устанавливает exit code 1.

Глобальной транзакции между циклами нет. Фиксация каждого save определяется [Store](../operations/persistence.md); отправка Telegram, запрос модели и календарные действия не откатываются вместе с локальным snapshot. Drain прерывает polling и source scopes; уже допущенные действия завершаются по правилам lifecycle.

Источник: [main.ts](../../../../src/main.ts), [observability.ts](../../../../src/worker/observability.ts).
