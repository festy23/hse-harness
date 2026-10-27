# Диалоги и страница Telegram истории

## Метод

telegramDialogs(client,ctx?) → TelegramDialog[]; telegramHistoryPage(client,peer,offsetId=0,limit=100,ctx?) → HistoryPage.

## Ресурсы

[RPC](telegram-rpc.md), teleproto entity utilities; постоянных изменений Store нет.

## Алгоритм telegramDialogs

1. Создать withOperation(connect,120000,ctx). out=[], seen IDs и offsets пустые, offsetId=0, offsetDate=0, offsetPeer=InputPeerEmpty, excludePinned=false.
2. Выполнить messages.GetDialogs с полями offsetId,offsetDate,offsetPeer,excludePinned из текущего состояния, limit=100, hash=bigInt.zero. Timeout/retry — [RPC](telegram-rpc.md). DialogsNotModified завершает protocol `Telegram не вернул список чатов`.
3. Создать entities по getPeerId из result.users и result.chats, исключив UserEmpty/ChatEmpty. Для каждого Api.Dialog в порядке result.dialogs найти entity; отсутствующие и seen IDs пропустить. Иначе добавить id в seen и out запись по таблице.

   | Поле результата | Правило |
   |---|---|
   | id | getPeerId(dialog.peer) |
   | title | entity.title для Chat/Channel, иначе пустая строка |
   | isGroup | entity instanceof Chat либо Channel с megagroup truthy |
   | isChannel | entity instanceof Channel |
   | entity | Исходный объект users/chats |
4. Если out.length>20000, завершить payload-limit. Если result.dialogs.length<100 либо result не DialogsSlice, вернуть out.
5. Найти последний Api.Dialog. При отсутствии и excludePinned=true вернуть out; при отсутствии и false установить true и повторить шаг 2 с прежними offsets.
6. Сформировать key=getPeerId(last.peer)+':'+last.topMessage. Уже встреченный key завершает protocol повторённой страницы; иначе добавить в offsets. Отсутствующий entity этого peer завершает protocol неполной страницы.
7. Найти message с тем же peerId и id=last.topMessage. Установить offsetId=last.topMessage, offsetDate=message.date при наличии date, иначе 0; offsetPeer=getInputPeer(entity), excludePinned=true. Повторить шаг 2.

## Алгоритм telegramHistoryPage

1. Выполнить messages.GetHistory по таблице через RPC.

   | Поле запроса | Формирование |
   |---|---|
   | peer,offsetId | Входные значения |
   | offsetDate,addOffset,maxId,minId | 0 |
   | limit | min(100,max(1,limit)) |
   | hash | bigInt.zero |
2. MessagesNotModified завершает protocol `Telegram не вернул историю`. Выбрать positive IDs из result.messages; nextOffset=min(ids), при пустом ids — входной offsetId.
3. Если result.messages непуст и offsetId truthy и nextOffset>=offsetId, завершить protocol `Telegram повторил страницу истории`.
4. Вернуть `{messages:result.messages,nextOffset,complete:result.messages.length<clampedLimit || ids.length===0}` без сортировки и фильтрации messages.

## Ошибки

| Код | Message | Условие |
|---|---|---|
| protocol | Не вернул список/историю; повторил страницу; неполная страница | Ветки алгоритмов |
| payload-limit | Слишком много Telegram-чатов | out.length>20000 |
| RPC | Ошибки telegramInvoke | Вызов RPC завершился неуспешно |
