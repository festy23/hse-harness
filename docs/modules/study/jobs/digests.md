# Сводки и первоначальная сверка

## Описание

Постановка утренней и вечерней сводки и ограничение их актуальности.

## Запуск

Scheduler.digests(now=Date.now()) в локальном 10-секундном цикле только после bootstrapFinished. Обработку queue выполняет [Assistant agent loop](../../assistant/jobs/agent-turn.md).

## Входные параметры

now: epoch ms, необязателен.

## Результат

void; постановка записи queue либо запись missedDigests. Ошибка save прерывает текущий вызов.

## Ресурсы

State.queue, delivered, missedDigests, bootstrapFinished, source progress; Bot, Pi.

## Алгоритм работы

1. Вычислить moscowHour(now), moscowDate(now). Для start=10, затем 20 вычислить id=`digest:${date}:${start}`.
2. Если delivered[id], missedDigests[id] или queue.some(id), пропустить.
3. При hour>=start и hour<start+2 добавить queue запись `{id,sources:[],digest:start===10?'morning':'evening'}`. При hour>=start+2 вместо этого записать missedDigests[id]=now. До start пропустить. После каждой мутации вызвать Store.save.
4. При получении digest агент должен проверить now>=scheduled+2h до подготовки и ещё раз после подготовки нового ответа. При просрочке записать missedDigests[id]=now, удалить запись queue по id, Store.save без отправки. Сохранённый phase=answer использует проверку до обработки, но не повторную после уже подготовленного ответа.
5. Для нового ответа с задержкой >120000 ms от scheduled добавить `Сводка восстановлена с задержкой; данные актуальны на момент подготовки.`. Зафиксировать phase=answer и answer; отправить с delivery id=`answer:${id}` при непустом тексте, затем удалить queue и записать delivered[id]=now в одном Store.save.
6. Пока bootstrapFinished=false, localTimers должен доставлять notices без напоминаний и digest. Если ready, все источники initialComplete, очередь пуста, !delivered.initialReview, отправить текст `Первоначальный разбор завершен. Отметь уже сданные работы обычным текстом, затем /ready.` с delivery id=initial-review; после успеха записать delivered.initialReview=now и Store.save. Автоматически устанавливать bootstrapFinished запрещено.
