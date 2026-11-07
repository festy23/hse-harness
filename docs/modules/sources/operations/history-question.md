# Ручное чтение истории и вопрос в чат

## Метод

history(chat,limit=50,ctx?) → Source[]; question(chat,text,randomId,ctx?) → string messageId.

## Ресурсы

[Connect](connect-telegram.md), peers/config.chats, [history page](telegram-pages.md), [Source mapping](telegram-sources.md), [RPC](telegram-rpc.md), [Study approvals](../../study/README.md).

## Алгоритм history

1. Создать tool operation 45000 ms, connect. Если peers не содержит chat, бросить `Чат не разрешен`.
2. Прочитать одну history page peer=peers.get(chat), offsetId=0, limit=min(max(input limit,1),100). Значение default=50; pagination и собственный retry здесь отсутствуют.
3. В порядке ответа оставить Api.Message с Boolean(m.message), без trim и без фильтра HISTORY_FROM. Преобразовать [source(chat,m)](telegram-sources.md) и вернуть массив. Не enqueue, не менять cursors, не вызывать onReply.

## Алгоритм question

1. Создать approval operation 45000 ms, connect. Если выбранный config.chats.find(id===chat)?.allowQuestions===false, завершить `Чат подключён только для чтения; отправка вопросов не разрешена`. Если peers не содержит chat, завершить `Чат не разрешен`.
2. Выполнить RPC messages.SendMessage.

   | Поле запроса | Источник |
   |---|---|
   | peer | peers.get(chat) |
   | message | text без изменения |
   | randomId | bigInt(randomId) |
3. При UpdateShortSentMessage вернуть String(r.id). Иначе при наличии updates пройти их в исходном порядке: первый UpdateMessageID с u.randomId.equals(bigInt(randomId)) возвращает String(u.id); первый UpdateNewMessage/NewChannelMessage с Api.Message возвращает String(u.message.id).
4. Если квитанция не найдена, бросить `Отправка не подтверждена id сообщения; повторю с тем же random_id`.

## Выход и ошибки

history отдаёт только полученную страницу и не гарантирует семестровую полноту. question не создаёт approval и не хранит randomId: эти гарантии обязан обеспечить вызывающий Study. В адаптере нет автоматического повтора, сообщения об ошибках о повторе описывают ожидаемое действие вызывающего. Ошибки connect/RPC/неразрешённого чата/неподтверждённой отправки передать; не выдавать успех без messageId. Текст, ID и разрешение не извлекать из содержимого учебного источника.
