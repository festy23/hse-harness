# Telegram poll slice

## Описание

Восстановить историю разрешённых чатов и применить доступные MTProto differences с сохранением позиции после ingestion.

## Запуск

[Core sourceLoop](../../core/jobs/worker.md) с именем Telegram, внешним budget connect+telegramSlice=180000 ms. При пустом config.chats loop возвращает complete=true,initialComplete=true без подключения. Иначе сначала connect, затем TelegramSource.poll(parent). Незавершённый slice повторяется через 1000 ms, завершённый через config.pollSeconds.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| parent | OperationContext | Нет | Отмена и ограничение времени |
| continuing | ()→boolean | Да | Разрешение продолжать; default true |

## Результат

`{complete:boolean,initialComplete:boolean}`. initialComplete=true только если complete=true и все текущие config.chats имеют truthy tgHistory cursor. Собственный deadline slice возвращает false/false, если parent не отменён; родительскую отмену и прочие ошибки пробрасывать.

## Ресурсы

[Connect](../operations/connect-telegram.md), [cursors](../database/README.md), [reconcile](../operations/reconcile.md), [difference](../operations/difference.md), [RPC](../operations/telegram-rpc.md).

## Алгоритм работы

1. Создать source operation budget 60000 ms с parent, выполнить connect(ctx). Снять snapshot peers=[...this.peers]; новые addChat не включать в текущий snapshot.
2. Если cursors.tgState отсутствует, вызвать updates.GetState({}) через RPC, записать JSON `{pts:s.pts,qts:s.qts,date:s.date,seq:s.seq}` и дождаться Store.save.
3. Для каждого [id,peer] snapshot: при !continuing вернуть incomplete; проверить ctx.throwIfAborted. Если peer — InputPeerChannel и tgChannel:id отсутствует, выполнить channels.GetFullChannel({channel:InputChannel({channelId:peer.channelId,accessHash:peer.accessHash})}). Потребовать full.fullChat instanceof ChannelFull и truthy pts; иначе ошибка `Не получен pts чата <id>`. Записать String(pts) и save.
4. Если tgHistory:id отсутствует, выполнить reconcile(id,ctx). При false вернуть incomplete; при true присвоить tgHistory:id='1' и save, затем перейти к следующему peer.
5. Пройти snapshot ещё раз: для InputPeerChannel с truthy tgResyncChannel:id выполнить channelDifference. При false вернуть incomplete. Если хотя бы один такой resync был возобновлён, вернуть incomplete и не запускать общий difference в этом slice.
6. Выполнить commonDifference(ctx). При false вернуть incomplete. Затем для каждого InputPeerChannel snapshot при continuing и после проверки отмены выполнить channelDifference; false завершает incomplete. После всех вернуть complete=true.
7. Сформировать initialComplete по текущему config.chats, а не snapshot. При исключении и ctx.signal.aborted: собственный deadline без отменённого parent вернуть false/false, иначе бросить ctx.signal.reason. Неотменённую ошибку передать вызывающему. В finally dispose ctx.

## Неуспешное выполнение

Ошибка RPC, недоступный чат, неверный pts, ошибочный cursor JSON или запись Store прерывает slice. Уже сохранённые enqueue и cursors не откатывать; возобновление использует их. Не считать complete=false ошибкой источника: Core сохраняет continuing=true и продолжает.
