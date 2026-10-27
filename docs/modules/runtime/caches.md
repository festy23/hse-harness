# Память Runtime

Redis не используется. Завершённые releases являются файловым хранилищем, а не кэшем с TTL.

| Тип | Ключ и значение | Время жизни и размер | Формирование и инвалидация |
|---|---|---|---|
| in-memory | Supervisor.waiters: Set `{worker,sequence,response,resolve,reject}` | До ответа, deadline, exit или IPC error; число незавершённых команд | Добавить до send; удалить при settle |
| in-memory | `worker`: `{id,attemptId,release,child,exit,exited,mode,activationRequested?,fatal?,nextReminder?}` | Один child; сохранять до замены подтверждённо вышедшего child | startWorker; exit меняет exited; heartbeat меняет nextReminder только при числовом поле |
| in-memory | `preparation`: `{version,controller,status,cancelled,target?,error?,completion}` | Не более одной подготовки; до завершения и потребления tick | beginPreparation; cancel помечает и abort, не удаляет до settle |
| in-memory | `observed`, `observations` | Одна версия и число наблюдений; жизнь supervisor | Счётчик увеличивается на той же версии, меняется на 1 при другой |
| in-memory | `lastHeartbeat`, `activatedAt` | Монотонные timestamps; жизнь текущего запуска worker | Обновление при health/activate; probation после reboot начинается заново |
| in-memory | `saves` | Одна Promise-цепочка | save добавляет immutable structuredClone; ошибка должна распространяться |
| in-memory | TelegramUpdates.busy | boolean, один tick | Установить на входе, снять в finally; конкурентный tick пропустить |

Ни один из этих ресурсов не должен заменять persisted attempt, request, notice или release identity при восстановлении. Недоступность IPC должна завершать соответствующие waiter и останавливать supervisor согласно [IPC](operations/ipc.md).
