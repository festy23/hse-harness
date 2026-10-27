# Решение и исполнение одобрения

## Метод

`Approvals.decide(id,accept,now=Date.now(),ctx?) -> Promise<void>`; внутренний execute.

## Описание

Исполнение одобренного вопроса или изменения занятия.

## Ресурсы

[Approval](propose-approval.md), [Calendar preview/matches/move](../../calendar/operations/study-calendar.md), [MTProto question](../../sources/README.md), inFlight и Store.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| id | string | Да | Approval UUID |
| accept | boolean | Да | Решение уже авторизованного владельца |
| now | epoch ms | Нет | Date.now() |
| ctx | OperationContext | Нет | Родительский предел |

Авторизацию callback должен выполнять Telegram Bot до вызова; сам decide не получает user id.

## Выходные параметры

void.

## Результат в случае успеха

Неизвестный id/неpending завершается без изменений. Reject устанавливает rejected. Успешный execute устанавливает sent и sent=now.

## Результат в случае ошибки

Сохранённый sending должен оставаться для recovery, кроме терминальных rejected ветвей stale/permission. Исход сетевого действия может быть неизвестен.

## Алгоритм работы

1. Найти первый approvals[id]. Отсутствующий либо state!=pending завершить без действий.
2. При accept=false установить state=rejected, Store.save, завершить. Иначе если now-created>86400000, установить rejected, Store.save, завершить expired. На точной границе суток разрешить исполнение.
3. Установить state=sending, Store.save **до** внешнего вызова; вызвать Execute с тем же now.

### Execute

1. Если inFlight содержит id, завершить без действия. Иначе добавить id; удалить в finally при любом исходе.
2. Открыть approval operation с question budget=45000 ms или lesson budget=90000 ms, ограниченный ctx.
3. Для question повторно потребовать allowedChats.has(payload.chat); иначе permission. Вызвать sender.question(chat,text,randomId,op). На успехе записать messageId из ответа; затем перейти к шагу 6. RandomId и текст при повторах не менять.
4. Для lesson вызвать sender.lessonMatches?(lessonId,start,end,op). При true перейти к шагу 6 без повторной записи. При false/отсутствующем методе продолжить.
5. Если previewLesson существует, получить текущий preview. Если старый preview отсутствует или не равен текущему, установить rejected, notice `stale-lesson:${id}` со строкой `Занятие изменилось после подготовки черновика. Старое одобрение отменено; для нового переноса нужно новое подтверждение.`, Store.save, завершить stale. Иначе вызвать sender.lesson(lessonId,start,end,op). Если previewLesson отсутствует, сразу вызвать lesson.
6. Установить state=sent, sent=now, Store.save. Не изменять created/payload/randomId/notified/answered.
7. При OperationError kind=permission в любом шаге установить rejected, записать notice `blocked-approval:${id}` со строкой `Повтор согласованного действия прекращён: доступ отозван. Исход прошлой попытки может быть неизвестен; проверь его перед новым подтверждением.`, Store.save; пробросить исходную ошибку. Другие ошибки пробросить без самостоятельного возврата в pending.

Повторное исполнение lesson должно считать совпадение целевых времён достаточным подтверждением принятой операции. Preview должен сравнивать только сформированную Calendar строку title/start/end, не ETag, description или всю серию.

### Маппинг изменений Approval

| Выборка | Поле | Правило |
|---|---|---|
| Первый approvals.id=id в pending | state | rejected при отказе/expiry; sending при принятии |
| Исполняемый question | messageId | Строка результата sender.question |
| Исполняемый question/lesson после успеха | state,sent | sent, вход now execute |
| Исполняемый stale/permission | state | rejected |
| Остальные поля Approval | Без изменения | Created, payload, randomId, notified и answered не переписывать |

При ошибке Store.save изменённый объект остаётся в памяти; долговечный результат не должен считаться подтверждённым и должен подчиняться fatal durability правилу Core.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| expired | exception | Черновик старше суток; подтвердите новый | Возраст >86400000 |
| permission | OperationError(permission) | Чат больше не разрешен / из sender | Отозванное право |
| stale | exception | Занятие изменилось; требуется новый черновик и согласие | Preview изменился |
| dependency | exception | Из sender/Store | Неизвестный исход, timeout, отмена, durability |
