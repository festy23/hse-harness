# Напоминания и notices

## Описание

Доставка известных напоминаний и срочных изменений независимо от модели.

## Запуск

Локальный цикл каждые 10000 ms после завершения. При bootstrapFinished=true параллельно выполнять tick(now,ctx) и digests; иначе только flushNotices. Внешний цикл имеет budget=120000 ms. Вызов urgent происходит также после применения работы.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| now | epoch ms | Нет | Date.now() |
| ctx | OperationContext | Нет | Отмена |
| urgent.t/previous | Task/Task? | Для urgent | Новая и прежняя работа |
| onlyKey | string | Нет для flushNotices | Ограничить доставку одним notice |

## Результат

void; при ошибках дождаться независимых задач и вернуть первую fatal, иначе первую ошибку. Недоставленные записи должны оставаться для повторной доставки через Bot outbox.

## Ресурсы

[Store](../database/README.md), [Scheduler locks](../operations/scheduler.md), [Bot delivery](../../telegram-bot/README.md), [reminderJobs](../../core/operations/domain.md).

## Алгоритм работы

1. tick должен пройти pending TaskOperation с writeAttempted!==false, не busy. При отсутствии delivered и notice ключа `calendar-uncertain:${op.id}` записать notice `Изменение «${op.desiredTask.title}» ожидает проверки календаря. Срок и статус сейчас не подтверждены; проверь календарь. Автоматически повторять изменение не буду.`; Store.save для каждой записи.
2. Собрать taskId jobs с due<=now и !delivered[job.id]. Параллельно запустить flushNotices и обработку taskId максимум четырьмя исполнителями. Busy task пропустить.
3. В transaction(taskId) при наличии pending операции этой работы пропустить отправку. Заново выбрать её jobs с due<=now и !delivered[id], сортировать due по убыванию. При пустом результате завершить без действия.
4. Отправить только самый поздний job: bot.send(text,undefined,`reminder:${latest.id}`,ctx). При now-latest.due>120000 добавить префикс `Напоминание восстановлено с задержкой.` и заменить начальное `До сдачи осталось…:` на `Проверь актуальный срок:`. Иначе text оставить неизменным.
5. Только после успешного bot.send записать delivered[id]=now для **всех** выбранных просроченных jobs этой работы; Store.save. Это объединение не должно отправлять каждое накопившееся напоминание отдельно.

### Urgent

1. В transaction(t.id) вычислить changed = previous существует и (deadline изменился либо новый status=cancelled при прежнем !=cancelled). Вычислить near = previous отсутствует, deadline есть, deadline-now<86400000; нижней границы нет. Если оба условия ложны, завершить.
2. key=`urgent:${t.id}:${t.deadline}:${t.status}`; удалить прочие urgent notices этой работы. При delivered[key] вызвать Store.save и завершить.
3. Записать notice: для cancelled `Отмена: ${course} — ${title}`; иначе `Изменение/близкий срок: ${course} — ${title}` и строка prettyTime(deadline) либо `Срок уточняется`, при disputed ещё `Срок спорный.`. Store.save; вызвать flushNotices(now,ctx,key).

### FlushNotices

1. Выбрать onlyKey либо Object.keys(notices), обработать максимум четырьмя исполнителями. Task id для urgent взять как второй сегмент key; для calendar-conflict/uncertain найти TaskOperation по точному ключу. Для остальных notice task id отсутствует.
2. Пропустить notice, если связанная task busy, либо urgent и task имеет pending operation. Для связанной task сначала войти в task transaction.
3. Для lock=`notice:${key}` пропустить уже удерживаемый другим scope lock; иначе войти в реентерабельный lock. Заново прочитать notices[key]; при undefined завершить.
4. При !delivered[key] вызвать bot.send(text,undefined,key,ctx). После успешной отправки либо уже существующего delivered установить delivered[key]=now, удалить notices[key], Store.save.

Завершение bot.send должно означать выполнение контракта outbox Telegram Bot, а не транспортную гарантию exactly-once. Ошибка следующего Store.save не должна инициировать новое намерение с другим delivery id.

## Маппинг состояния доставки

| Выборка записи | Поле/значение | Момент записи |
|---|---|---|
| notices[calendar-uncertain:id] | Точная строка шага tick 1 | До попыток напоминаний |
| notices[urgent key] | Точная строка Urgent 3 | До bot.send |
| delivered[job.id] всех выбранных просроченных jobs taskId | now | После одного успешного bot.send |
| delivered[notice key] | now | После успешного/ранее подтверждённого send |
| notices[notice key] | Удалить | В той же фиксации, что delivered[notice key] |

Остальные jobs и delivered записи должны сохраняться без изменения. Вызов Store.save после мутации должен быть точкой локальной фиксации; при его неуспехе не должно выполняться подтверждение внешнему вызывающему как успешного завершения.
