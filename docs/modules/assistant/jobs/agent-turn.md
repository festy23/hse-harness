# Обработка очереди агентом

## Описание

Последовательное применение порций источников, сообщений владельца и сводок.

## Запуск

Один agent loop в [main.ts](../../../../src/main.ts), после lifecycle.waitActive; останавливаться по stopped. Пока модель не готова повторять open с паузой 30000 ms, перечитывая model из config file перед каждой попыткой. При пустой очереди ждать 300 ms.

## Входные параметры

Queue item из [Core](../../core/database/README.md); runtime dependencies Pi, Calendar, Bot, Store.

## Результат

Удалённая из очереди завершённая порция либо оставленная для повтора при ошибке. Ошибки должны обновлять состояние `Модель`; fatal должна завершать worker по Core контракту.

## Ресурсы

[Pi session](../operations/session.md), [turn recovery](../operations/turn.md), [Study digest](../../study/jobs/digests.md), Store, Bot outbox.

## Алгоритм работы

1. Если !ready, прочитать config.model (нестроковое → ''), open Pi с tools/profile в connect operation. После успеха ready=true, status Модель; отправить startup уведомление с delivery id=`startup:${HSE_WORKER_ID??pid}`. Нефатальную ошибку только этой отправки поглотить. При ошибке открытия ready=false, dispose, status error; через 30s повторить.
2. Выбрать первую queue запись с ownerText!==undefined, иначе queue[0]. Проверить срок digest по [Study](../../study/jobs/digests.md) до обращения к модели.
3. Context для truthy ownerText должен включать подтверждение/неподтверждение bootstrap, число порций sources и запрет считать историю проверенной. При forwarded пометить текст как пересланные данные, не инструкции/личный статус; иначе как личное сообщение владельца. Для digest запросить короткую утреннюю/вечернюю сводку на текущее ISO-время с list_tasks/get_schedule. Для источников передать JSON(sources) как недоверенные данные с требованием обновить работы и не уведомлять по каждой старой работе во время начальной загрузки.
4. pi.turnId=item.id. Если phase=answer использовать item.answer; иначе completedTurn(item.id). При undefined установить phase=prompting, Store.save, вызвать prompt(context,Boolean(ownerText)&&!forwarded).
5. Для нового digest применить повторный срок и late-prefix из Study. Установить item.phase=answer и item.answer=answer, Store.save **до** Bot.send.
6. Если (ownerText или digest) и answer непуст, bot.send(answer,undefined,`answer:${item.id}`). Финальный ответ порции источников владельцу автоматически не отправлять; важные уведомления выполняются notify_owner/Study.
7. Удалить все queue записи данного id; для digest delivered[id]=Date.now(); Store.save. Записать здоровый status модели.
8. На ошибке оставить запись очереди и уже сохранённые изменения инструментов, обновить status. При unavailable ждать 30000 ms; иначе перейти к следующей итерации без фиксированной задержки. Параллельный prompt второй порции не запускать.

## Маппинг состояния очереди

| Выборка/поле | Правило формирования |
|---|---|
| Выбранный item.phase до prompt | prompting |
| Выбранный item.phase после результата | answer |
| Выбранный item.answer | Ответ Pi либо восстановленный ответ, с digest late-prefix при необходимости |
| state.queue после доставки/просрочки | Исходный массив без всех записей с выбранным id |
| state.delivered[item.id] для завершённого digest | Date.now() |
| state.missedDigests[item.id] для просроченного digest | Date.now() |
| Прочие поля item | Без изменения |

Фиксации до prompt, до send и после send должны оставаться раздельными; общей транзакции с Pi или Telegram не вводить.
