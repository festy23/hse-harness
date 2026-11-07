# Полная сверка доступной Telegram истории

## Метод

Внутренняя reconcile(chat,ctx) → boolean; вызывается первичным poll и восстановлением difference too long.

## Ресурсы

[cursors/seen](../database/README.md), [history page](telegram-pages.md), [messages/deleted](telegram-sources.md), peers.

## Алгоритм работы

1. Прочитать cursors[`tgScan:<chat>`]. Если строка есть, parseRecord и получить scan={offset:requiredNumber,found:numberArray,before:numberArray}; ошибка чтения/типов завершает вызов. При отсутствии создать scan из таблицы, found Set из scan.found.

   | Поле scan | Начальное значение |
   |---|---|
   | offset | 0 |
   | found | [] |
   | before | Все ключи Store.seen, начинающиеся `tg:<chat>:`, последний сегмент преобразовать Number; порядок Object.keys |
2. Пока true: если !continuing либо ctx.remainingMs()<50, вернуть false. Иначе проверить отмену и получить telegramHistoryPage(client,peers.get(chat),scan.offset,100,ctx).
3. complete=page.complete, batch=[]. Пройти page.messages в исходном порядке. При наличии date и date<HISTORY_FROM epoch seconds установить complete=true и прекратить просмотр страницы. Для остальных добавить message.id в found Set и message в batch, включая не-Api.Message объекты.
4. Дождаться messages(batch). Затем scan.offset=page.nextOffset, scan.found=[...found], scan.before оставить; записать cursors.tgScan=JSON.stringify(scan), дождаться save.
5. Если !complete, перейти к шагу 2. Иначе вызвать deleted(chat,scan.before.filter(id=>!found.has(id))). После его успеха удалить tgScan, присвоить tgHistory='1', save и вернуть true.

## Результат и ошибки

false означает сохранённую либо ещё не начатую незавершённую сверку; true — достижение конца доступной истории либо сообщения старше HISTORY_FROM. При ошибке history/enqueue/save/deleted не переходить к последующим действиям; сохранённый scan даёт точку продолжения. Удаление seen ID, которого нет в доступной истории, передавать свидетельством deleted, не отменой работы. Результат не восстанавливает содержимое, которое Telegram уже не предоставляет.
