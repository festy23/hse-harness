# Supervisor IPC

## Метод

Node child_process IPC: Supervisor.send, command, startWorker; приём worker определён в [Core worker control](../../core/operations/worker-control.md).

## Описание

Связать команды переключения с конкретным worker, попыткой и sequence.

## Ресурсы

Один child, waiters [caches](../caches.md), [journal](../database/README.md), release validation, process signal handlers.

## Входные параметры

Команда должна сериализоваться Node IPC как объект `{protocolVersion:1,attemptId:worker.attemptId,workerId:worker.id,sequence:++sequence,type,...extra}`. sequence должен монотонно увеличиваться в пределах supervisor. extra для notice — `{id,text}`.

| type | Ожидаемый ответ | Timeout |
|---|---|---|
| prepare | boot-ready | bootMs |
| activate | active | bootMs |
| drain | quiescent | drainMs |
| resume | active | bootMs |
| finish | exit child, без waiter | finishMs |
| notice | notice-sent, отдельный async handler | повторная доставка ticks |

## Выходные параметры

send должен вернуть отправленный envelope либо undefined при закрытом worker/channel. command должен вернуть matching response или отклонить Promise. startWorker должен вернуть запись текущего worker.

## Результат в случае успеха

Кандидат должен пройти локальный prepare, затем activate; журнал runningVersion должен обновиться после подтверждения active. Ответы старой sequence не должны завершать новую команду.

## Результат в случае ошибки

Синхронная/асинхронная ошибка send должна отклонить waiters именно captured worker, установить первую backgroundFailure и requestStop. Ошибка от уже заменённого/вышедшего captured worker должна игнорироваться. Неподтверждённый activate должен считаться потенциально активировавшим worker.

## Алгоритм работы

1. command должен требовать живой worker, зарегистрировать waiter с worker, ожидаемой sequence=`current+1`, response и timeout до send. При любом settle удалить timer/waiter. Отсутствие send результата — IPC.
2. startWorker должен validate release, проверить stopping; создать UUID worker и mode preparing. Spawn node `[packageRoot/dist/main.js]`, cwd=home, stdin ignore, stdout/stderr options.stdio??inherit, IPC.
3. Env должен объединять process.env, options.workerEnv, затем обязательные HSE_HARNESS_HOME, HSE_WORKER_ID, HSE_SUPERVISOR='1', HSE_RELEASE_VERSION, HSE_RELEASE_INTEGRITY. Установить lastHeartbeat=clock.
4. Exit/error child должен установить exited и отклонить все его waiters, разрешить worker.exit; code/signal сохранить для exit.
5. При incoming message от другого worker, exited worker, без payload, с неверным workerId/protocol или JSON.stringify.length>65536 — игнорировать. Health должен обновить lastHeartbeat, числовой health.nextReminder и завершить обработку до проверки attemptId.
6. Для других сообщений требовать attemptId. fatal должен сохранить Error с detail/code, очищая URL и ограничивая до 500 символов. notice-sent должен удалить notice с этим id и запланировать save; ошибка save должна вызывать failBackground. Для waiter требовать worker и sequence; response завершает успехом, boot-failed/fatal — IPC, прочее не завершает waiter.
7. Послать prepare и дождаться boot-ready. При stopping либо false shouldActivate() — CANCEL. Затем **до send activate** установить activationRequested=true. Дождаться active, установить mode active, lastHeartbeat и activatedAt=clock, save и вернуть worker.
8. При доставке notices отправлять все сохранённые `{id,text}` только живому mode active worker. Повторять до notice-sent; дедупликация внешней доставки принадлежит [Telegram Bot](../../telegram-bot/README.md).

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| IPC | rejected Promise | Timeout <type> / Worker IPC… / Worker exit… / detail | Нет подтверждённого ответа, exit или отказ worker |
| CANCEL | Error.code | STOP_CANCELLED / UPDATE_CANCELLED | Остановка или запрещённая активация |
| RESOURCE | rejected Promise | validate/save error | Выпуск или journal не подтверждены |
