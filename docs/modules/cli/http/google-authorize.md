# URL авторизации Google

## Метод

Внешний браузерный `GET https://accounts.google.com/o/oauth2/v2/auth`.

## Описание

Передать пользователю URL согласования OAuth.

## Ресурсы

[OAuth flow](../operations/google-auth.md), loopback server, notify.

## Входные параметры

| Поле query | Источник или правило формирования |
|---|---|
| client_id | проверенный clientId |
| redirect_uri | http://127.0.0.1:<actual listener port>/callback |
| response_type | code |
| scope | https://www.googleapis.com/auth/calendar.events, calendar.app.created, calendar.calendarlist.readonly с полным префиксом для каждого, соединённые пробелом |
| access_type | offline |
| prompt | consent |
| state | randomBytes(24).toString('hex') |

Body и headers CLI не задаёт; запрос выполняет браузер пользователя.

## Выходные параметры

URL должен передаваться notify; code/error должны приниматься только [callback](google-callback.md).

## Результат в случае успеха

HTTP-ответ провайдера напрямую CLI не читает. Успех должен определяться callback и последующим token exchange.

## Результат в случае ошибки

Отсутствие callback должно завершить общий OAuth timeout; callback error должен завершить flow AUTH.

## Алгоритм работы

1. После успешного listen сформировать URL через URLSearchParams из таблицы.
2. Notify должен содержать URL и необходимость SSH forwarding actual port для VPS. Не вызывать автоматический браузер.
3. Ожидать code/interrupted в пределах timeoutMs по [flow](../operations/google-auth.md); повторной попытки URL внутри flow нет.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| AUTH | HTTP браузера не наблюдается | Google не подтвердил вход | callback error |
| TIMEOUT | HTTP отсутствует | Время входа Google истекло | Общий timer |
