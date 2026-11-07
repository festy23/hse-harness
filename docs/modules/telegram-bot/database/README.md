# Состояние Telegram Bot

Использовать общий файловый [Store](../../core/database/README.md); отдельную БД не создавать. Все нижеуказанные изменения фиксировать `Store.save()`. Транзакции с Telegram не существует; запись квитанции следует после HTTP-вызова.

| Поле State | Формат | Запись и назначение |
|---|---|---|
| `botOffset` | Неотрицательное safe integer; начальное 0 | Следующий update_id; продвигать по завершённому префиксу координатора |
| `botIdentity` | `telegram:<1–20 цифр>` либо `telegram:opaque:<24 hex>`; необязательно | Пространство дедупликации текущего бота |
| `botRetryAt` | Неотрицательное safe integer UTC epoch ms; необязательно | Общая для всех Bot API методов граница flood cooldown |
| `ownerUpdates[key]` | `true`; key `<identity>:<updateId>`, без identity — десятичный updateId | Дедупликация постановки текста владельца |
| `queue[]` | `{id,sources:[],ownerText,forwarded?}` | `id=owner:<key>` при updateId, иначе UUID; forwarded присутствует только при true |
| `outbox[deliveryId]` | `{text,buttons?,chunks,created,ambiguous?}` | text и buttons исходного вызова, created=Date.now(); существующая запись определяет содержимое всех повторов |
| `chunks[]` | `{state:'pending'\|'sending'\|'sent',messageId?:number}` | По одной записи на часть; messageId записывать только после успешного sendMessage |
| `ambiguous` | Необязательный boolean | Присваивать true при повторе части из sending; автоматически не сбрасывать |

Отсутствующие outbox и ownerUpdates трактовать как пустые словари при создании состояния. Не удалять завершённую доставку в send(). При смене identity выполнять Core.activateBot: первая активация переносит цифровые ключи дедупликации в namespace, последующая смена сбрасывает offset в 0; обе удаляют botRetryAt и сохраняют identity. Токен в identity не сохранять.

Ресурс `bootstrapFinished` принадлежит Core/Study; команда `/ready` присваивает ему true до отправки подтверждения. Runtime-состояние npmUpdates здесь не изменять.
