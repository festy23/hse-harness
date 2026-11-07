# Polling личного бота

## Описание

Читать Bot API updates и продвигать подтверждённый offset.

## Запуск

Один bots loop worker после создания CommandCoordinator; выполняется до stopped. Lifecycle останавливает приём/прерывает текущий polling во время остановки или pause.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| store,bot,lifecycle,coordinator | object | Да | Экземпляры worker |
| stopped | boolean | Да | Признак остановки |

## Результат

Итерация сохраняет offset завершённых updates и запускает обработку новых; завершение loop при stopped. Fatal ошибка (OperationError kind durability/invariant) завершает loop неуспешно.

## Ресурсы

[getUpdates](../http/get-updates.md), [координатор](../operations/coordinator.md), health/status Core, [настройки](../settings.md).

## Алгоритм работы

1. Пока !stopped дождаться lifecycle.waitActive; при stopped завершить. coordinator.check пробрасывает сохранённую fatal failure.
2. В lifecycle.run выполнить coordinator.advance, создать новый polling AbortController, вызвать bot.updates(Store.botOffset,polling.signal), передать полученное в observe, затем снова advance. При lifecycle.accepting вызвать status('Бот').
3. При fatal ошибке пробросить; при иной и lifecycle.accepting вызвать status('Бот',error). В finally убрать polling controller из переменной worker.
4. Если !stopped ждать lifecycle.sleep(1000), затем повторить шаг 1. Отдельного backoff на HTTP ошибки loop не вводит; transport блокирует все запросы до botRetryAt.

isFast возвращает true для неавторизованного update и непересланного точного /help или /status; остальные задачи медленные. answerCallback вызывает bot.ack(id,stopAbort.signal), подавляя nonfatal ошибки и пробрасывая fatal. ACK запускается для всех callback, включая неавторизованные; действия затем проверяют владельца. Отправка повышенного offset в следующий getUpdates подтверждает Telegram завершённые записи после их локального save; сам ACK этого не делает.
