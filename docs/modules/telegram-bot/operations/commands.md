# Команды и авторизация

## Метод

Owner handler в main.ts, OperationContext owner-command, budget 90000 ms, parent stopAbort.signal. В этом контракте fatal означает только OperationError с kind durability либо invariant; остальные ошибки считать nonfatal.

## Ресурсы

[Store](../database/README.md), [доставка](send.md), [Calendar](../../calendar/README.md), [Study approvals](../../study/README.md), [Runtime updates](../../runtime/README.md), Core progress/status.

## Входные параметры

BotUpdate по контракту getUpdates. message.forward_origin использовать только как признак `!== undefined`, содержимое не интерпретировать. Commands сопоставлять полным точным текстом без trim, аргументов, @suffix или удаления регистра.

## Алгоритм работы

1. Если update_id < botOffset либо isOwner=false, завершить без действия. isOwner=true только при message.from.id=owner, message.chat.id=owner, chat.type='private' либо callback.from.id=owner, callback.message.chat.id=owner и type='private'. Inline callback без message не авторизуется.
2. Для callback сначала вызвать Runtime updates.callback(u,ctx); если true, завершить. Иначе split(data??'', ':') и использовать первые action,id. При непустом id и action approve/reject вызвать approvals.decide(id,action==='approve',Date.now(),ctx). При fatal ошибке пробросить; при иной доставить `Действие не завершено. Проверь актуальность черновика; при сетевом сбое повтор использует тот же идентификатор отправки.` Затем завершить. Неизвестный callback также завершить без reply.
3. При отсутствующем или пустом message.text отправить `Пока обрабатываю только текст. Пришли задание или вопрос текстом.` и завершить.
4. Только если forward_origin===undefined, применить ветвь команд из таблицы. После её окончания завершить handler.
5. Для прочего текста вызвать Store.enqueueOwner(text,update_id,bot.identity,forward_origin!==undefined), дождавшись сохранения. Если ready=false, отправить `Сообщение сохранено в очереди. Подключения еще не готовы; отвечу после восстановления. /status — состояние.`; иначе немедленный ответ не отправлять. Ответ агента доставляет очередь Core/Assistant.

| Команда | Порядок действий и результат |
|---|---|
| /help | Доставить botHelp с deliveryId `help:<identity>:<update_id>` |
| /updates | Дождаться Runtime.checkManually(u,ctx) |
| /status | Получить runtimeStatus; доставить JSON.stringify(status,null,2) с полями из следующей таблицы |
| /tasks | calendar.listTasks под budget history=45000; fatal пробросить, иную ошибку передать status('Календарь',error), затем сообщить недоступность календаря; при успехе соединить строки работ двойным newline |
| /ready | Если хотя бы один source progress.initialComplete=false либо queue.length>0, отправить `Обработка источников или твоих отметок еще идет. Дождись завершения сверки.` Иначе присвоить bootstrapFinished=true, save, затем `Напоминания включены. Сообщай «сделал <задание>» и «сдал <задание>».` |
| /start | Отправить вводный текст основного личного диалога, botHelp и при !ready уведомление о настройке подключений |

| Поле /status | Источник |
|---|---|
| health,queued,remindersEnabled,missedDigests | State.health, queue.length, bootstrapFinished, missedDigests |
| starting,sources | !ready, progress |
| eventLoop | responsiveness?.snapshot(), undefined опустить JSON |
| operations,commands | activeOperations(), coordinator?.status() |
| calendars,updates | config.calendars, await runtimeStatus() |
| subscriptionRemaining | `достоверный остаток пока недоступен` |

/tasks сохраняет порядок calendar.listTasks и формат `<id>: <course> — <title>\n<prettyTime(deadline) либо Без срока>; <status>`. prettyTime применяет Intl.DateTimeFormat ru-RU, timeZone=Europe/Moscow, dateStyle=medium,timeStyle=short к new Date(deadline). Пустой массив даёт `В календаре пока нет работ. Задания без срока доступны в диалоге агента.` Ошибка календаря даёт `Календарь сейчас недоступен, поэтому список работ получить не удалось. Попробуй /tasks позже; другие сообщения принимаю.`

runtimeStatus при отсутствующем HSE_HARNESS_HOME возвращает undefined. Иначе прочитать `<HSE_HARNESS_HOME>/runtime/state.json`, JSON.parse и objectValue для корня, active, attempt и attempt.to: non-null object без Array оставить, любое иное значение заменить на {}. Любая ошибка чтения/разбора возвращает undefined без ошибки команды. Результат /status.updates формировать по таблице; undefined поля опускать при JSON.stringify.

| Поле updates | Источник |
|---|---|
| installedVersion | runtime.installedVersion |
| runningVersion | env HSE_RELEASE_VERSION ?? active.version |
| supervisorVersion | runtime.supervisorVersion |
| updatesEnabled | runtime.updatesEnabled |
| phase | attempt.phase ?? runtime.phase |
| pendingVersion | attempt.to.version |
| lastSuccessfulSwitch | runtime.lastSuccessfulSwitch |
| deferredReason | runtime.deferredReason |
| failure | attempt.failure |
| availableVersion | Store.npmUpdates?.latest?.version |
| requestedVersion | Store.npmUpdates?.request?.version |
| requestState | Store.npmUpdates?.request?.phase |

Все reply, кроме /help и собственных Runtime сообщений, используют deliveryId `command:<identity>:<update_id>:reply`. botHelp формировать из botCommands в порядке start,help,tasks,status,updates,ready: заголовок `Команды учебного помощника:`, затем строки `/<command> — <description>` через два newline и пояснение различия «сделал»/«сдал», обычного текста и owner-only режима. Descriptions фиксировать следующими строками:

| command | description |
|---|---|
| start | Открыть личный диалог с помощником и узнать, как им пользоваться. |
| help | Показать все команды и пояснения к ним. |
| tasks | Показать работы из календаря: предмет, срок и статус. О заданиях без срока спроси обычным сообщением. |
| status | Показать состояние подключений, очередь обработки, напоминания и версию бота. |
| updates | Проверить новую версию в npm и получить кнопку «Обновить». Доступно при постоянном запуске npm-установки. |
| ready | Включить напоминания после первоначального разбора истории и сверки сданных работ. Дождись обработки очереди перед этой командой. |

После списка команд botHelp добавляет через два newline текст `Также пиши обычным текстом: задавай вопросы, присылай текст заданий, сообщай «сделал …» или «сдал …». После «сделал» напоминания о сдаче продолжаются; после «сдал» прекращаются.`, затем через два newline `Команды и сообщения принимаю только от владельца в личном диалоге.`

/start соединяет `Это основной личный диалог с твоим учебным помощником. Ответы, сводки и напоминания приходят от этого бота.`, два newline и botHelp; при !ready добавляет два newline и `Подключения еще настраиваются. Твои сообщения сохраню в очереди; /status покажет состояние.`

Объявление botCommands само по себе не вызывает setMyCommands: меню Telegram через API в этом модуле не регистрировать. [Исходные тексты](../../../../src/bot-commands.ts).

## Ошибки и фиксация

Необработанная ошибка handler оставляет update для coordinator retry. enqueueOwner сохраняет очередь и ключ дедупликации совместно через Core; доставка использует outbox. /ready может уже сохранить bootstrapFinished при ошибке последующей доставки. ACK callback выполняется отдельно координатором до/параллельно решению и сам по себе не разрешает действие.
