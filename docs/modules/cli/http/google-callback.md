# Временный OAuth callback

## Метод

Локальный `GET http://127.0.0.1:<port>/callback`, listener доступен только на loopback в течение authorizeGoogle.

## Описание

Принять authorization code связанного запроса Google.

## Ресурсы

Node http server, state nonce, codePromise, OAuth lifetime.

## Входные параметры

| Название | Тип | Обязательность | Расположение | Описание |
|---|---|---|---|---|
| state | string | да | query | Должен строго совпасть с nonce текущего flow |
| code | string | при успехе | query | Непустой код |
| error | string | нет | query | Само наличие означает отказ |

## Выходные параметры

HTTP text/plain для валидного state; успешный code разрешает codePromise. Обработка неправильного запроса не завершает ожидающий flow.

## Результат в случае успеха

HTTP200 `Авторизация получена. Можно закрыть окно.`; headers content-type='text/plain; charset=utf-8', cache-control='no-store'.

## Результат в случае ошибки

Некорректный URL/method/path/state —HTTP400 `Invalid callback`. Валидный state, но error либо нет code —HTTP200 `Авторизация отменена. Вернись в терминал.` и reject codePromise SetupIssue.

## Алгоритм работы

1. Parse new URL(req.url??'/',redirect); ошибка→HTTP400/return.
2. Требовать req.method GET, pathname /callback и searchParams.get('state')===state. Иначе HTTP400/return без закрытия listener.
3. Установить content-type/cache-control. Получить code. Наличие error либо falsy code→текст отмены и reject; иначе текст успеха и resolve(code).
4. Listener должен закрываться в finally внешнего OAuth flow. Promise должен принимать только первое settlement; отдельное хранение/повторная обработка callback не выполняется.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| INVALID | 400 | Invalid callback | URL/method/path/state |
| DENIED | 200 | Авторизация отменена… | Ошибка OAuth/нет code; rejected flow |
