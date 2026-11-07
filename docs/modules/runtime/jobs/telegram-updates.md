# Периодическая проверка npm через Telegram

## Описание

Обнаруживать новые версии и продолжать согласованный запрос после перезапуска.

## Запуск

TelegramUpdates.tick должен вызываться worker; расписание вызовов принадлежит [Core worker](../../core/jobs/worker.md). Локальный busy исключает перекрытие tick, lifetime AbortSignal запрещает новый tick после остановки.

## Входные параметры

Конструктор и state определены в [операции Telegram](../operations/telegram-updates.md).

## Результат

Один tick должен выполнить одну ветвь ниже и освободить busy в finally. Неуспешный npm discovery должен отложить повтор на минуту; ошибка состояния должна выйти caller. Установка автоматически по наличию latest запрещена.

## Ресурсы

[State](../database/README.md), [runtime](../operations/npm-install.md), [latest](../http/latest.md), [offer/pending](../operations/telegram-updates.md).

## Алгоритм работы

1. При busy или aborted завершить. Установить busy=true; snapshot undefined — завершить. Получить npmUpdates и request.
2. Для active request:
   1. authorizing: grant(id), phase pending, save; продолжить эту же ветвь.
   2. Если snapshot.stable и runningVersion>=request.version: restore(id), phase completed, удалить offer/pendingNotice, save, завершить.
   3. awaiting-apply и !updatesEnabled: fail и завершить. Для phase!=pending, quarantined version и !retryPending: fail и завершить.
   4. pending и quarantined version: phase installing, workerId=current, save; runtime.install. При отказе, если !aborted, fail; завершить. При успехе phase awaiting-apply/save/завершить.
   5. Если installedVersion>=request.version: phase awaiting-apply/save/завершить.
   6. Для installing: если request.workerId!=current, fail; иначе оставить как есть; завершить. Для awaiting-apply при ещё меньшей installedVersion — fail/завершить.
   7. Иначе phase installing, workerId=current, save; runtime.install. При отказе aborted — завершить с сохранённой installing; при другом отказе fail. Если после вызова phase всё ещё installing, поставить awaiting-apply/save. Завершить.
3. Без active request и с pendingNotice выполнить pending(snapshot) и завершить; discovery в том же tick не выполнять.
4. Если !checkedAt либо now-checkedAt>=1h, latest; при ошибке checkedAt=now-1h+60000, save, завершить. При успехе latest=release, checkedAt=now, save.
5. После await снова проверить active request; если появился — завершить. Иначе offer(snapshot) с daily cooldown.
6. fail должен сначала restore(request.id), затем request.phase=failed. Создать offer из request с новым UUID только если offer отсутствует. Записать pendingNotice `{id:'npm-failed:'+request.id,text:сообщение_о_незавершении_с_версией,offerId:offer.id,version:request.version}`; save; получить новый snapshot и при наличии pending(snapshot). Fail не должен откатывать учебные данные.
7. В finally busy=false. Завершённость обновления должна уведомляться supervisor commit notice; отдельное completed сообщение здесь не создаётся.
