# Приём входных данных

## Метод

`Store.enqueue(sources, ctx?)`, `Store.enqueueOwner(ownerText, updateId?, identity?, forwarded?)`,
`Store.activateBot(identity)`.

## Ресурсы

[State.queue, seen, ownerUpdates, botIdentity, botOffset, botRetryAt](../database/README.md).
Commit выполняется через [Store.save](persistence.md).

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| sources | Source[] | Для enqueue | Упорядоченные сообщения |
| ctx | OperationContext | Нет | Отмена во время подготовки |
| ownerText | string | Для enqueueOwner | Исходный owner text |
| updateId | number | Нет | ID Telegram update |
| identity | string | Нет | Default state.botIdentity |
| forwarded | boolean | Нет | Default false; происхождение текста |

## Выходные параметры

Promise<void>; при успехе enqueue/enqueueOwner принятые порции и dedupe markers
находятся в одном durable снимке. При совпадении dedupe новый save не вызывается.

## Алгоритм работы enqueue

1. Для каждого Source в исходном порядке проверить ctx.throwIfAborted.
2. Вычислить fingerprint SHA-256(JSON.stringify(source)). Если seen[id] совпадает,
   пропустить Source. Иначе подготовить его без изменения state.
3. При text.length ≤ 6000 подготовить один исходный Source. При большей длине
   использовать total=ceil(length/5800), offsets 0,5800,...; каждый фрагмент содержит
   те же поля Source и text=`[Часть i/total одного источника id; границы перекрываются]`
   плюс newline и slice(offset,offset+6000). Единица длины — JS UTF-16 code unit.
4. Между обработками вызывать yieldIfNeeded; после подготовки проверить отмену.
5. Повторно отфильтровать prepared по текущему seen, чтобы исключить уже принятую
   конкурентной операцией ту же версию. При пустом accepted завершить успешно.
6. Без await между мутациями записать seen[id]=fingerprint для accepted, flatten
   фрагменты и разбить их на группы до 4. Для каждой создать QueueItem по таблице.
7. Await save. При ошибке сохранить fatal семантику persistence; курсор источника
   вызывающий модуль не должен подтверждать до успешного enqueue.

| Поле QueueItem | Источник |
|---|---|
| id | randomUUID() |
| sources | Последовательная группа до 4 фрагментов |
| ownerText/forwarded/digest/phase/answer | Не записываются |

## Алгоритм работы enqueueOwner

1. Если updateId отсутствует, dedupe key отсутствует. Иначе key=`identity:updateId`
   при truthy identity, либо String(updateId).
2. При ownerUpdates[key]=true завершить без изменения даже при отличающемся тексте
   или forwarded. Изначальное происхождение повтором не повышается до owner authority.
3. Добавить QueueItem и при наличии key поставить ownerUpdates[key]=true.
4. Await save, затем вернуть успешно.

| Поле QueueItem | Источник |
|---|---|
| id | `owner:<key>` либо randomUUID() без updateId |
| sources | `[]` |
| ownerText | Входной ownerText |
| forwarded | literal true только при truthy forwarded; иначе поле отсутствует |
| digest/phase/answer | Не записываются |

## Алгоритм работы activateBot

1. При отсутствующей identity либо равенстве state.botIdentity завершить без записи.
2. Если прежняя botIdentity отсутствует, для каждого цифрового legacy ownerUpdates
   key добавить `identity:key`=true, сохранив прежние ключи и offset.
3. Если прежняя identity была иной, установить botOffset=0.
4. Удалить botRetryAt, установить botIdentity=identity, await save.
   Очередь, outbox и прежние ownerUpdates при смене бота не удалять.

## Ошибки

cancelled/deadline из ctx прерывают подготовку enqueue до мутации. Durability
после мутации завершает вызов ошибкой и блокирует дальнейшие записи Store.
Неизвестные ошибки хеширования/сериализации передаются вызывающей стороне.
Источник: [store.ts](../../../../src/store.ts).
