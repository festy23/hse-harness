# Доставка текста

## Метод

`send(text,buttons?,deliveryId=randomUUID(),ctx?) → Promise<void>`.

## Ресурсы

[outbox и Store](../database/README.md), [sends](../caches.md), [sendMessage](../http/send-message.md), OperationContext.

## Входные и выходные параметры

text — обязательная string; buttons — необязательный массив строк кнопок `{text,callback_data}`; deliveryId — string ключ доставки, при отсутствии новый UUID; ctx — необязательный контекст отмены. Успех — void, когда все части подтверждены. Пустой текст образует ноль частей и успешную пустую доставку.

## Алгоритм работы

1. Если sends содержит deliveryId, вернуть его Promise, не сравнивая новый текст с существующим. Иначе начать sendChunks, сохранить Promise в sends, удалить запись в finally.
2. Прочитать outbox[deliveryId]. Если запись есть, заменить text/buttons её сохранёнными полями. Разбить text regexp `/[\s\S]{1,3500}/gu` с сохранением порядка.
3. При Store и отсутствии записи создать поля из таблицы и дождаться save до первого HTTP-вызова.

   | Поле | Значение |
   |---|---|
   | text,buttons | Входные значения, buttons необязательно |
   | chunks | По одной `{state:'pending'}` на часть |
   | created | Date.now() |
4. Для каждой части по индексу выполнить ctx.throwIfAborted при наличии ctx. Если receipt.state=sent, перейти к следующей части.
5. Запомнить uncertain=(receipt.state=sending). При uncertain установить delivery.ambiguous=true. Установить receipt.state=sending и дождаться save. Без Store пропустить изменения receipt.
6. Выполнить sendMessage: chat_id=owner, text=(при uncertain `Повтор после сбоя: предыдущая доставка могла состояться.\n`, иначе пусто)+часть, preview disabled, buttons только в последней части.
   1. При BotApiRejection и receipt вернуть state в sending для uncertain или pending иначе; дождаться save.
   2. При других ошибках оставить sending. Если ctx.signal.aborted, выбросить signal.reason; иначе исходную ошибку. Завершить вызов, последующие части не отправлять.
7. При успехе установить receipt.state=sent, receipt.messageId=result.message_id, дождаться save, перейти к следующей части. После последней завершить void.

## Ошибки и гарантии

| Код | Message | Последствие |
|---|---|---|
| provider | BotApiRejection | Известный отказ текущей попытки; сохранённая прежняя неопределённость остаётся |
| transport/protocol | Ошибка HTTP/JSON/квитанции | Доставка могла состояться; повтор получает предупреждающий префикс |
| cancelled/deadline | OperationContext.reason | Неотправленные части остаются для повтора |
| storage | Ошибка Store.save | Прервать вызов; состояние файла определяется Core |

Сохранённые sent части не повторять. Между HTTP эффектом и save квитанции возможен сбой: exactly-once не обещать. В send нет цикла автоматического retry или глобальной очереди всех доставок; повтор инициируется вызывающим с тем же deliveryId. Существующий id всегда фиксирует старое содержимое. Без Store допускается только объединение одновременных вызовов в текущем процессе.
