# Преобразование Telegram сообщений в Source

## Метод

Внутренние source(chat,m), messages(items), updates(items), deleted(chat,ids).

## Ресурсы

[Core.enqueue и seen](../../core/operations/ingestion.md), peers, HISTORY_FROM, onReply callback Study.

## Маппинг Source

| Поле | Значение |
|---|---|
| id | `tg:<chat>:<m.id>` |
| kind | telegram |
| text | m.message |
| date | new Date(m.date*1000).toISOString() |
| author | getPeerId(m.fromId), если m.fromId есть, иначе undefined |
| replyTo | `tg:<chat>:<replyToMsgId>`, только для MessageReplyHeader и truthy replyToMsgId |
| url | `https://t.me/c/<chat.slice(4)>/<m.id>`, только chat начинается -100 |

## Алгоритм работы

1. messages проходит items в исходном порядке. Пропустить не Api.Message, date < HISTORY_FROM в epoch seconds, и getPeerId(m.peerId) отсутствующий в peers.
2. Сформировать Source. При наличии replyTo сначала await onReply(chat,lastSegment(replyTo)). Этот callback вызывается и для сообщения без непустого текста; ошибка прерывает текущую обработку.
3. Если m.message.trim() truthy, добавить Source в texts; иначе не enqueue. После просмотра входных items передавать texts последовательными группами по 20 в Store.enqueue, дожидаясь каждой записи. Ошибка enqueue прекращает обработку следующих групп.
4. updates проходит items последовательно. UpdateNewMessage/NewChannelMessage/EditMessage/EditChannelMessage передать в messages([u.message]). UpdateDeleteChannelMessages передать deleted('-100'+u.channelId,u.messages). UpdateDeleteMessages передать deleted для каждого peers key, не начинающегося -100. Прочие update типы игнорировать.
5. deleted фильтрует ids по truthy seen[`tg:<chat>:<id>`], сохраняя порядок; формирует Source по таблице ниже и вызывает Store.enqueue для всего массива, включая пустой.

   | Поле | Значение |
   |---|---|
   | id,kind | `tg:<chat>:<id>`, telegram |
   | text | `Исходное сообщение удалено. Само удаление не подтверждает отмену задания.` |
   | date | HISTORY_FROM |
   | deleted | true |

## Результат и ошибки

Возвращать void после сохранения всех групп. Не продвигать внешние cursors здесь: это делает вызывающий poll/reconcile после enqueue. Ошибку onReply, преобразования даты или Store передавать вызывающему. Source id остаётся одинаковым при редактировании/удалении; версионную дедупликацию выполнять в Core, не в адаптере.
