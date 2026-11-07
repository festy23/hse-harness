# Lifecycle и IPC worker

## Метод и ресурсы

WorkerLifecycle управляет mode, счётчиком inFlight и AsyncLocalStorage scope.
WorkerControl.receive(value:unknown) обрабатывает команды supervisor по IPC.
Managed transport определён в [Runtime](../../runtime/README.md).

## Допуск операций

| Метод | Предусловие | Результат |
|---|---|---|
| activate | mode не finishing/stopped | active, пробуждение ожиданий |
| drain | active либо draining | draining, запрет новых root calls |
| quiescent | draining и count=0 | quiescent |
| finish | quiescent | finishing |
| stop | любое | stopped |
| run(operation) | active либо уже допущенный AsyncLocalStorage scope | Увеличить count, await operation, уменьшить count в finally |
| run вне допуска | не active и нет scope | undefined без вызова operation |
| idle(predicate?) | count>0 и predicate не false | Ждать count=0 либо predicate=false |
| waitActive | не active и не terminal | Ждать active или terminal |
| sleep(ms) | не terminal | Таймер, прерываемый сменой mode |

Вложенная операция принятого scope допускается после drain. Успешный drain
не отменяет уже принятые owner side effects. Попытка недопустимого перехода бросает Error.

## Входной IPC контракт

| Поле | Тип | Обязательность | Правило |
|---|---|---|---|
| protocolVersion | literal 1 | Да | Иные игнорируются |
| workerId | string | Да | Должен совпасть с instance workerId |
| attemptId | string | Да | Непустой, длина ≤128 |
| sequence | safe integer | Да | ≥1 |
| type | enum | Да | prepare/activate/drain/resume/finish/notice |
| text | string | Для notice | ≤8000 |
| id | string | Для notice | ≤200 |

Значение должно быть object и JSON.stringify(value).length≤16384. Нарушения
структуры/идентичности не вызывают действия и не получают ACK. Ошибка JSON.stringify
возникает до обработки команды и отклоняет receive без локального failure ACK.

## Формирование ответа

| Поле | Источник |
|---|---|
| protocolVersion | 1 |
| attemptId | Команда |
| workerId | WorkerControl instance |
| sequence | Команда |
| type | boot-ready/active/draining/quiescent/exiting/notice-sent/health/boot-failed/fatal |
| id | Только notice-sent: notice.id |
| code/detail | Только failure: классификация и безопасное описание |

reply отправляет ACK только если latest всё ещё указывает на эту команду.
Для команд кроме notice повтор с sequence===latest.sequence и теми же attemptId/type
повторяет сохранённый тип ACK и базовый envelope без повторного действия. Сохраняется
только строка acknowledgement: дополнительные code/detail прежнего failure ACK
при повторе не восстанавливаются. Старые sequence этих команд игнорируются.
notice не меняет latest и обрабатывается до сравнения sequence: старый либо повторный
notice снова вызывает actions.notice при active, оставляя дедупликацию действиям main.

## Алгоритм команд

1. notice допускается только в active. В lifecycle.run вызвать actions.notice,
   дождаться сохранения, отправить notice-sent с id. При ошибке вызвать fatal с
   code=state-invariant и detail=`Worker notice persistence failed` относительно latest
   команды (если latest существует), затем отклонить receive новым Error с тем же
   текстом. Исходную ошибку notice не передавать. Если допуск закрыт — завершить без ACK.
2. Остальные команды после проверки sequence становятся latest; предыдущий
   acknowledgement сбрасывается.
3. prepare разрешён только один раз в inactive: await actions.prepare,
   prepared=true, boot-ready. Установить heartbeat каждые 5000 ms.
4. activate разрешён только prepared/inactive: lifecycle.activate,
   actions.transition(active), await actions.activate, затем active ACK.
5. drain: lifecycle.drain, transition(draining), отправить draining ACK;
   дождаться idle, пока latest совпадает и mode=draining. Если пришла новая команда,
   прекратить этот drain. Иначе await checkpoint, повторить проверку актуальности,
   lifecycle.quiescent, отправить quiescent.
6. resume разрешён только draining/quiescent: activate, transition(active), active ACK.
7. finish разрешён только quiescent: finish, exiting ACK, остановить heartbeat,
   await actions.finish. ACK exiting предшествует фактическому выходу процесса.
8. При ошибке шага 3 отправить boot-failed; для остальных — fatal,
   code=state-invariant, detail=`Worker lifecycle or checkpoint failed`, затем
   передать исходную ошибку вызывающей стороне.

## Heartbeat

Отправлять latest attemptId/sequence, type=health, mode, inFlight,
optional process.env.HSE_RELEASE_VERSION и actions.health(). Ошибка callback
посылает fatal state-invariant. close отменяет heartbeat.

Источник: [lifecycle.ts](../../../../src/worker/lifecycle.ts).
