# Общий и канальный MTProto difference

## Метод

commonDifference(ctx) и channelDifference(id,peer,ctx) → boolean. Один вызов выполняет не более 100 итераций, исчерпание возвращает false.

## Ресурсы

[State.cursors](../database/README.md), [RPC](telegram-rpc.md), [ingestion](telegram-sources.md), [reconcile](reconcile.md), alert notifier.

## Алгоритм commonDifference

1. На каждой итерации при !continuing вернуть false, иначе проверить отмену. Прочитать s=JSON.parse(cursors.tgState); прочитать и типизированно разобрать tgResync, если он существует.
2. При pending resync не выполнять GetDifference. Иначе вызвать updates.GetDifference с pts=s.pts,date=s.date,qts=s.qts. При DifferenceTooLong создать resync: fresh=await updates.GetState({}), chats=[...peers.keys()],done=[]. До следующего возобновления fresh остаётся исходным объектом Api.updates.State; его JSON включает unreadCount и className. Разбор сохранённого tgResync оставляет в fresh только pts,qts,date,seq.
3. При наличии resync записать tgResync=JSON.stringify(resync), save. Если !noticeSent, вызвать alert с текстом `Telegram: сервер не отдал весь пропущенный поток. Перепроверяю доступную историю; удаленные сведения могут быть недоступны.`, deliveryId=`tg-resync:<hash(JSON.stringify(fresh)).slice(0,24)>`, ctx. После успешной доставки присвоить noticeSent=true, записать resync и save.
4. Для каждого id из resync.chats в сохранённом порядке пропустить id в done. Остальные reconcile(id,ctx); false завершает false. После каждого true добавить id в done, записать resync и save. После всех записать tgState=JSON.stringify(fresh), удалить tgResync, save и вернуть true.
5. Без resync потребовать наличие d и не DifferenceTooLong, иначе invariant `Отсутствует состояние Telegram difference`. При DifferenceEmpty записать JSON `{...s,date:d.date,seq:d.seq}`, save и вернуть true.
6. Для Difference/DifferenceSlice сначала messages(d.newMessages), затем updates(d.otherUpdates). next=intermediateState для Slice либо state для Difference. Записать tgState=JSON `{pts:next.pts,qts:next.qts,date:next.date,seq:next.seq}`, save. При Difference вернуть true; при Slice перейти к следующей итерации. Поле newEncryptedMessages здесь не обрабатывать.

## Алгоритм channelDifference

1. На каждой итерации при !continuing вернуть false; проверить отмену. Прочитать tgResyncChannel:id: JSON number трактовать как {pts:number}; object проверить на requiredNumber pts и optionalBoolean noticeSent. При отсутствии resync выполнить запрос по таблице.

   | Поле updates.GetChannelDifference | Формирование |
   |---|---|
   | channel | InputChannel({channelId:peer.channelId,accessHash:peer.accessHash}) |
   | filter | new ChannelMessagesFilterEmpty() |
   | pts | Number(cursors[tgChannel:id]) |
   | limit,force | 100,true |
2. При ChannelDifferenceTooLong потребовать d.dialog instanceof Dialog и truthy d.dialog.pts; иначе Error `Нет pts после ChannelDifferenceTooLong`. Создать resync={pts:d.dialog.pts}.
3. При resync записать JSON в tgResyncChannel:id, save. Если !noticeSent, вызвать alert(`Чат <id>: часть обновлений недоступна. Перепроверяю текущую историю.`,`tg-channel-resync:<id>:<pts>`,ctx). После успеха присвоить noticeSent=true, записать JSON, save. Затем reconcile(id,ctx); false завершает false. При true pts=resync.pts и удалить tgResyncChannel:id.
4. Без resync потребовать d и не ChannelDifferenceTooLong; иначе invariant `Отсутствует состояние Telegram channel difference`. pts=d.pts. Только для ChannelDifference выполнить messages(d.newMessages), затем updates(d.otherUpdates); ChannelDifferenceEmpty не enqueue.
5. Записать tgChannel:id=String(pts), save. Если d отсутствует либо d.final truthy, вернуть true; иначе перейти к следующей итерации. Вновь полученный TooLong с d.final=false может продолжить следующий difference в том же вызове; возобновлённый из cursor resync завершается после сверки.

## Ошибки и гарантии

| Код | Message/условие | Последствие |
|---|---|---|
| invariant | Отсутствующее состояние difference | Завершить вызов без продвижения позиции |
| protocol/data | JSON/тип/pts ошибка | Передать ошибку вызывающему |
| RPC / notification / storage | Сбой внешнего запроса, alert, enqueue/save | Прервать текущую ветвь; ранее сохранённые контрольные точки остаются |

Уведомление о resync отправлять до сканирования; noticeSent писать только после его успеха. Повтор alert использует тот же deliveryId outbox. Позицию fresh/pts применять только после всех необходимых enqueue; каждый шаг save использует [Core persistence](../../core/operations/persistence.md). Файлового rollback нескольких save не существует.
