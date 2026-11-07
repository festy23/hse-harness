# Вычислительный поток

## Метод

ComputeClient.run(job,ctx?), runCompute(job,ctx?), ComputeClient.close(), closeCompute().

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| job | HtmlComputeJob / CalendarComputeJob | Да | Дискриминатор type |
| ctx | OperationContext | Нет | Родительский budget/signal |
| workerUrl | URL | Нет | Default dist/compute/worker.js для TS entry, ./worker.js для compiled |
| budgetMs | number | Нет | 30000 ms |
| maxQueued | number | Нет | 8 ожидающих |

HtmlComputeJob: type='html', mode=hse/mail, html:string, optional baseUrl:string,
maxBytes:number. CalendarComputeJob определяется [календарным модулем](../../calendar/README.md).

## Ресурсы

Один lazy Worker, одна active задача, FIFO queue, sequence counter, scopes,
maxOldGenerationSizeMb=256. Долговременной очереди нет.

## Алгоритм работы run

1. Если closed, отклонить cancelled `Вычислитель закрыт`. Если active существует
   и queue.length≥maxQueued, отклонить rate-limit `Очередь вычислений заполнена`.
2. Создать cpu scope с родительским budget. Создать Pending с ++sequence и
   подпиской на abort. Уже отменённый scope dispose и reject без постановки.
3. Добавить Pending в queue. Если active отсутствует и client не closed, извлечь
   первый элемент и назначить active. Запустить worker при необходимости.
4. worker.ref, postMessage `{id,job}`. Ошибка запуска/передачи даёт protocol
   `Не удалось запустить вычислитель` и завершение worker.
5. Worker выбирает htmlCompute при type=html, иначе calendarCompute. Отправляет
   `{id,ok:true,value}` либо `{id,ok:false,error:{kind,message}}`. Для не-OperationError
   kind=protocol; URL в message заменить `[URL]`, ограничить сообщение 500 символами.
6. Parent игнорирует packet с id, отличным от active.id. Успешный packet завершается
   value, ошибочный — OperationError packet.error.kind/message либо protocol default.
   worker error/exit завершает active protocol error.
7. finish исполняется один раз на Pending; повтор ждёт его finished. Если успех
   пришёл после отмены либо deadline, заменить результат соответствующей ошибкой.
8. Удалить abort listener и dispose scope. При active cancellation terminate worker
   и дождаться завершения до reject задачи; убрать active и unref оставшийся worker.
   При queued cancellation убрать соответствующий элемент из queue.
9. Resolve/reject caller, отметить finished и запустить следующую задачу.
10. close ставит closed=true, отклоняет все queued, завершает active с terminate,
    затем завершает оставшийся idle worker. Общий singleton после close не переоткрывается.

## HTML алгоритм и результат

1. Выбрать limit=1000000 bytes для hse; для mail maxBytes либо 2000000.
   Потребовать safe integer 1..8388608 и Buffer.byteLength(html)≤limit.
   Нарушение даёт payload-limit `Слишком большой HTML документ`.
2. Для mail выполнить html-to-text convert с wordwrap=false, skip img, ссылки
   сохраняют href; вернуть `{text,links:[]}`.
3. Для hse найти quoted href регулярным выражением в исходном HTML, разрешить URL
   относительно baseUrl, принять только HTTPS без credentials/port с hostname
   hse.ru либо его поддоменом. Неверный URL пропустить. Удалять дубли Set;
   остановить сбор при 200 уникальных ссылках.
4. Для hse text получить convert с wordwrap=false, baseElements body;
   links вернуть в порядке первого появления.

## Ошибки и гарантии

Нет автоматического повторного запуска неуспешной задачи. Следующая задача может
получить новый worker. Возвращаемый generic тип не заменяет runtime-валидацию
результата вызывающим модулем. Ошибка самого асинхронного finish поднимается в
queueMicrotask как Error и не поглощается.

Источники: [client](../../../../src/compute/client.ts), [jobs](../../../../src/compute/jobs.ts),
[worker](../../../../src/compute/worker.ts), [HTML](../../../../src/compute/html.ts),
[index](../../../../src/compute/index.ts).
