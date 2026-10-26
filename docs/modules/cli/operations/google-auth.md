# Авторизация Google

## Метод

authorizeGoogle(options={}): Promise<void>.

## Описание

Выполнить authorization-code OAuth с проверкой state и сохранить обновляемые токены.

## Ресурсы

[authorize URL](../http/google-authorize.md), [callback](../http/google-callback.md), [token](../http/google-token.md), google.json, secret/env, writeSecret, Node http server.

## Входные параметры

GoogleAuthOptions: notify?,signal?,port?,request?,tokenPath?,clientId?,clientSecret?,timeoutMs?. Defaults определены [settings](../settings.md); request=fetch, tokenPath=secretsDir/google.json, notify=console.log.

## Выходные параметры

void; сохранённый google.json по [database](../database/README.md).

## Результат в случае успеха

Токены должны быть записаны после проверки ответа и lifetime signal. Callback browser success должен подтверждать только получение authorization code, а не запись токенов.

## Результат в случае ошибки

Существующий google.json должен оставаться до writeSecret. Вызывающая transaction должна компенсировать auth при последующей отмене выбора календаря. Server должен закрываться в finally.

## Алгоритм работы

1. Получить clientId/clientSecret из options??secret; требовать trim nonempty и отсутствие CR/LF/NUL. Требовать safe integer port0..65535 и finite timeoutMs>0. Уже aborted signal — CANCEL.
2. Создать lifetime controller; внешний abort задаёт SetupCancelled, таймер timeoutMs — SetupIssue об истечении времени. Promise interrupted должен отклоняться reason; attached catch предотвращает unhandled rejection. Сгенерировать state=randomBytes(24).toString('hex').
3. Создать server с [callback handler](../http/google-callback.md) и promise code; codePromise rejection наблюдать. Race server.listen(port,'127.0.0.1') с interrupted. Ошибка listen — LOCAL_PORT. Требовать числовой server.address; redirect=`http://127.0.0.1:<actual port>/callback`.
4. Сформировать [Google authorize URL](../http/google-authorize.md), передать notify с URL и actual port. Автоматическое открытие браузера не выполняется. Race codePromise/interrupted.
5. Передать code/client/redirect в [token exchange](../http/google-token.md); сетевую ошибку при aborted lifetime заменить reason, иначе TOKEN. После успешного HTTP parse response.json racing interrupted. Невалидный JSON — TOKEN; aborted lifetime сохраняет исходную причину.
6. Проверить token object; access_token/refresh_token должны быть непустыми после trim строками; expires_in finite number>0; Date.now()+expires_in*1000 должно быть finite. Иначе TOKEN. Проверить lifetime перед записью.
7. Сформировать `{access_token:value.access_token,refresh_token:value.refresh_token,expires_in:value.expires_in,expires_at:Date.now()+value.expires_in*1000}`. writeSecret(tokenPath,JSON.stringify(saved)); вернуть void.
8. В finally clear timeout, снять внешний abort listener; server.close и server.closeAllConnections, дождаться close callback.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| INPUT | SetupIssue | Укажи client… / Некорректный порт… / время… | Предусловия |
| LOCAL_PORT | SetupIssue | Не удалось открыть локальный порт Google OAuth… | Listen/address |
| AUTH | SetupIssue | Google не подтвердил вход… | Валидный callback с error/без code |
| TOKEN | SetupIssue | Не удалось обменять код / HTTP / некорректные данные… | Сеть, статус, формат, expiry |
| CANCEL | SetupCancelled | Настройка отменена | Внешний abort |
| TIMEOUT | SetupIssue | Время входа Google истекло… | Общий lifetime |
| RESOURCE | rejected Promise | writeSecret/close error | Файловое сохранение/закрытие |
