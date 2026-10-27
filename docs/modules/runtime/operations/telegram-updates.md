# Команда и кнопка обновления Telegram

## Метод

TelegramUpdates.checkManually(update,ctx), callback(update,ctx).

## Описание

Получить одобрение владельца на установку конкретных version и integrity.

## Ресурсы

[State npmUpdates](../database/README.md), [latest](../http/latest.md), [runtime adapter](npm-install.md), [Telegram owner и outbox](../../telegram-bot/README.md), Core Store.save/flush.

## Входные параметры

update — BotUpdate; ctx — необязательный OperationContext; bot — identity/send/isOwner; workerId — текущий UUID; signal — lifetime worker; now — Date.now по умолчанию.

## Выходные параметры

checkManually — void; callback — false только для data без префикса `hse_update:`, иначе true.

## Результат в случае успеха

Только callback владельца с актуальной offer identity должен создать request. Обнаружение версии и /updates сами установку не запускают.

## Результат в случае ошибки

Недоступность npm должна давать безопасное сообщение владельцу. Ошибки Store.save должны распространяться; устойчивая запись должна предшествовать выдаче кнопки и установке.

## Алгоритм работы

1. Получение state должно создать npmUpdates={} при отсутствии. При смене bot.identity заменить botIdentity и удалить offer/lastOfferedAt/pendingNotice; latest/request сохранить.
2. checkManually должен игнорировать не-владельца. Ответы использовать delivery id `npm-command:<botIdentity>:<update_id>`. При undefined snapshot сообщить о необходимости постоянной npm-установки и завершить. При active request (`authorizing|pending|installing|awaiting-apply`) сообщить уже выполняющуюся версию и завершить.
3. Вызвать latest(ctx). При ошибке сообщить о временной невозможности проверки и завершить. После await повторить проверку active request. Затем записать latest и checkedAt=now, Store.save; выполнить offer(manual=true,delivery=`npm-manual:<botIdentity>:<update_id>`).
4. callback должен проверить префикс, затем isOwner; не-владелец получает true без побочных эффектов. Сравнить весь data с `hse_update:<offer.id>`; отсутствие/несовпадение — сообщение об устаревшей кнопке с id `npm-callback:<botIdentity>:<update_id>`.
5. Получить snapshot; undefined — true. Если runningVersion>=offer.version — сообщить текущую версию; active request — сообщить выполняющуюся; обе ветви завершают true.
6. Повторно latest(ctx); ошибка — безопасное сообщение, true. После await повторить active guard. Если version или integrity отличаются от offer, заменить latest/save; выполнить новое manual offer без прежнего delivery; завершить true без установки.
7. Создать request `{version:offer.version,integrity:offer.integrity,id:UUID,workerId,phase:'authorizing',created:now}`; Store.save; runtime.grant(request.id); phase pending; Store.save; отправить стартовое уведомление с delivery `npm-start:<request.id>`; true.

### Формирование предложения и доставка

1. offer должен читать latest. Если отсутствует или version<=runningVersion, при manual отправить текущую версию и отсутствие обновлений с переданным delivery; завершить. При !manual и lastOfferedAt заданном с now-lastOfferedAt<24h завершить без предложения.
2. Если offer version/integrity отличаются от latest, заменить offer на `{...latest,id:UUID}`; Store.save до формирования notice.
3. Текст должен включать running→latest, предложение установить и сохранение памяти/очереди; при disabled добавить временный характер разрешения. Keyboard: одна строка, одна кнопка `{text:'Обновить',callback_data:'hse_update:'+offer.id}`.
4. pendingNotice должен получить `{id:delivery??'npm-offer:'+botIdentity+':'+UUID,text,offerId:offer.id,version:latest.version}`; lastOfferedAt=now; Store.save; pending(snapshot).
5. pending должен удалить notice/save, если runningVersion>=notice.version. Иначе отправить с тем же text/offerId/id. При подтверждённом send удалить pendingNotice и save. При исключении send выполнить Store.flush и сохранить pendingNotice для повторной доставки; flush error должен распространяться.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| REGISTRY | обработанный отказ | Не удалось проверить npm / выбранную версию | Повтор владельцем либо job |
| STALE | обработанный отказ | Эта кнопка устарела… | Offer не совпадает |
| RESOURCE | rejected Promise | Store/runtime error | Нельзя подтвердить durable request |
