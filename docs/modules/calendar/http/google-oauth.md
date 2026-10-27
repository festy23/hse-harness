# Обновление токена Google

## Метод

`POST https://oauth2.googleapis.com/token`.

## Описание

Обновление истёкшего access token.

## Ресурсы

[google.json и writeSecret](../database/README.md), [Google кэш](../caches.md).

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| client_id | string | body form | Да | secret(GOOGLE_CLIENT_ID) |
| client_secret | string | body form | Да | secret(GOOGLE_CLIENT_SECRET) |
| refresh_token | string | body form | Да | Загруженный tokens.refresh_token |
| grant_type | string | body form | Да | refresh_token |

## Выходные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| access_token | string | Да | Новый токен; вернуть вызывающему token |
| expires_in | number | Да | Секунды; преобразовать в expires_at=now+expires_in*1000 |

## Результат в случае успеха

Любой 2xx с JSON; сохранить google.json, затем вернуть access_token. Старый refresh_token сохранять.

## Результат в случае ошибки

Promise отклоняется; общий refreshing очищается в finally. Если запись файла не удалась, изменённый объект tokens уже остаётся в памяти.

## Алгоритм работы

1. token должен проверить ctx отмену, лениво прочитать и JSON.parse google.json. Отсутствие/ошибку файла пробросить.
2. При expires_at > Date.now()+60000 вернуть cached token. Иначе создать один общий refreshing Promise или присоединиться к существующему.
3. Отправить URLSearchParams с полями таблицы; signal=AbortSignal.timeout(20000), отдельный от отмены ожидающего ctx. Повторы не выполнять.
4. Non-2xx: отменить body и завершить oauth-http. Успех: разобрать JSON через limitedResponse с лимитом 1000000 bytes; транспорт отдельной проверки типов полей не выполняет.
5. Заменить tokens, вызвав writeSecret с JSON всей записи; дождаться записи. Снять refreshing через finally. После ожидания token повторно проверить ctx отмену и вернуть token.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| oauth-http | non-2xx | Google OAuth: N; повторите setup google | Refresh отклонён |
| dependency | Нет/2xx | Исходная ошибка | Чтение, секрет, JSON, лимит, запись, timeout |
