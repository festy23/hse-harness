# Транспорт Google Calendar

## Метод

`Google.request(path,method='GET',body?,ctx?)`; базовый URL `https://www.googleapis.com/calendar/v3/`. Вызовы: [GET списка](google-events-list.md), [GET события](google-events-get.md), [PUT](google-events-put.md), [POST](google-events-post.md), [PATCH](google-events-patch.md), [DELETE](google-events-delete.md).

## Описание

Авторизованный исходящий HTTP-вызов Calendar v3.

## Ресурсы

[OAuth](google-oauth.md), [лимиты](../settings.md).

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| path | string | path/query | Да | Относительный путь Calendar v3 |
| method | string | method | Нет | GET по умолчанию |
| Authorization | string | header | Да | `Bearer ${await token(op)}` |
| Content-Type | string | header | Да | application/json |
| body | unknown | body | Нет | JSON.stringify только если не undefined |

## Выходные параметры

Для HTTP 204 вернуть undefined; для прочего 2xx вернуть JSON response без отдельной проверки схемы транспортом.

## Результат в случае успеха

HTTP 200–299. Потребить JSON body с потоковым лимитом 8388608 bytes.

## Результат в случае ошибки

Отклонить Promise. Для non-2xx отменить body; выбросить Error с числовым status и сообщением `Google Calendar: ${status}`. Общего повтора и обновления токена по HTTP 401 нет.

## Алгоритм работы

1. Открыть request operation на 30000 ms, ограниченный ctx.
2. Получить token; если cached expires_at > now+60000 использовать access_token, иначе [refresh](google-oauth.md).
3. Выполнить fetch(base+path) с таблицей запроса и signal=op.signal.
4. Для non-2xx завершить `http`; для 204 вернуть undefined; иначе читать limitedResponse.json. При объёме >8388608 отменить reader и завершить payload-limit; при malformed JSON завершить parse. Отмена чтения должна отменять исходный reader.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| http | Любой non-2xx | Google Calendar: N | Ошибка API, status сохранён |
| payload-limit | 2xx | Ответ календаря превышает допустимый размер | Размер body превышён |
| parse | 2xx | JSON parse error | Неверный JSON |
| transport | Нет | Исходная ошибка | fetch/OAuth/отмена |
