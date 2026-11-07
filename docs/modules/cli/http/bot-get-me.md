# Проверка Telegram-бота при настройке

## Метод

Внешний `GET https://api.telegram.org/bot<token>/getMe`.

## Описание

Проверить token и получить username для личной ссылки бота.

## Ресурсы

UI.task, fetch, token из текущей setup transaction. Основной Bot API контракт принадлежит [Telegram Bot](../../telegram-bot/README.md).

## Входные параметры

| Название | Тип | Обязательность | Расположение | Описание |
|---|---|---|---|---|
| token | string | да | path | Credential владельца |
| signal | AbortSignal | нет | локально | Отмена task |

Query/body/специальные headers отсутствуют.

## Выходные параметры

username:string должен браться из result.username и matching `^[A-Za-z0-9_]+$`.

## Результат в случае успеха

HTTP 2xx, ok=true, валидный username → вернуть username.

## Результат в случае ошибки

Не выводить URL token или сырой ответ; SetupCancelled сохранить; SetupIssue сохранить; прочее преобразовать в безопасный SetupIssue о token/соединении.

## Алгоритм работы

1. ui.task; до fetch проверить signal. GET с redirect='error', AbortSignal.any(timeout20000,task signal при наличии); retry отсутствует.
2. Проверить task signal после fetch. При !response.ok — HTTP. response.json; после parse снова проверить signal. Любая отмена task должна иметь приоритет SetupCancelled.
3. Требовать object result, ok===true, наличие result; account object должен иметь string username по regex. Иначе DATA. Вернуть username. Другие поля getMe не сохранять и не использовать для ownerId.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| HTTP | полученный не-2xx | Проверь токен бота и соединение с Telegram | Отказ API |
| DATA | локальный | Не удалось проверить Telegram-бота | Неожиданный envelope/account |
| TRANSPORT | HTTP отсутствует | Не удалось подключиться к Telegram-боту… | Сеть, redirect, timeout/JSON |
| CANCEL | локальный | Настройка отменена | Пользовательская отмена |
