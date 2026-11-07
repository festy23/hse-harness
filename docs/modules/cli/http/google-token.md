# Обмен OAuth code Google

## Метод

Внешний `POST https://oauth2.googleapis.com/token`.

## Описание

Обменять подтверждённый authorization code на обновляемые токены.

## Ресурсы

fetch из GoogleAuthOptions, OAuth lifetime, [flow](../operations/google-auth.md).

## Входные параметры

| Поле body URLSearchParams | Источник или правило формирования |
|---|---|
| client_id | clientId |
| client_secret | clientSecret |
| code | callback code |
| redirect_uri | исходный loopback redirect |
| grant_type | authorization_code |

Body должен кодироваться URLSearchParams; дополнительных query/headers CLI не задаёт. Fetch должен установить корректный content type для URLSearchParams.

## Выходные параметры

JSON access_token, refresh_token, expires_in должны проверяться и преобразовываться в google.json по [flow](../operations/google-auth.md); прочие поля не сохраняются.

## Результат в случае успеха

HTTP2xx с валидными токенами должен допускать файловую запись; одного 2xx недостаточно.

## Результат в случае ошибки

Non-2xx должен стать SetupIssue `Google OAuth: HTTP <status>. Повтори вход.`. Transport/parse/shape ошибки должны преобразовываться безопасно. Повторов token exchange нет.

## Алгоритм работы

1. Fetch(method POST,redirect error,body по таблице,signal=any(lifetime,timeout20000)); race interrupted.
2. При ошибке, если lifetime aborted, выбросить lifetime.reason; иначе SetupIssue о невозможности обмена. При !ok — HTTP.
3. response.json racing interrupted; ошибка JSON при не-aborted lifetime — DATA. Проверить и сохранить результат только в шагах6–7 [flow](../operations/google-auth.md).

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| HTTP | полученный non-2xx | Google OAuth: HTTP… | API отказ |
| DATA | локальный | Google вернул некорректный ответ/данные… | Формат ответа |
| TRANSPORT | HTTP отсутствует | Не удалось обменять код Google… | Сеть/redirect/20s timeout |
| LIFETIME | локальный | reason внешнего flow | Отмена/общий deadline |
