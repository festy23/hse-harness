# Запись и перенос CalDAV

## Метод

`PUT {resource.url}` через createCalendarObject/updateCalendarObject.

## Описание

Создание события, замена события агента или перенос выбранного занятия.

## Ресурсы

[REPORT и resolve](caldav-report.md), [compute](../operations/icalendar.md), [transport](caldav-discovery.md).

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| resource.url | URL | path | Да | resolve(event.id/id) |
| Authorization | Basic | header | Да | Клиент провайдера |
| Content-Type | string | header | Да | text/calendar; charset=utf-8 |
| If-None-Match | string | header | Только создание | * |
| If-Match | string | header | Только update/move | ETag прочитанного ресурса, передаёт tsdav |
| body | string | body | Да | Результат compute serialize/move |

## Выходные параметры

void; response body не используется и должен отменяться.

## Результат в случае успеха

HTTP 200–299. Отдельного readback коллекция не выполняет; сверка обязательства принадлежит Study.

## Результат в случае ошибки

Не выполнять retry или rollback. Неизвестный результат HTTP передать вызывающему.

## Алгоритм работы

1. В tool operation 90000 ms применить resolve, прочитать существующий ресурс через полный REPORT.
2. Для put вычислить compute serialize(event). Если существующий ресурс есть, потребовать truthy ETag и передать `{...existing,data}` в updateCalendarObject. Иначе передать calendar, filename=последний segment target URL, iCalString=data, headers If-None-Match:* в createCalendarObject.
3. Для move потребовать существующий ресурс и ETag до compute. Вычислить action=move с исходным data, target id, start/end; передать `{...existing,data}` в updateCalendarObject. После compute проверить abort перед сетевой записью.
4. Передавать fetchOptions.signal=op.signal. Отменить тело ответа; non-2xx завершить http. Wrapper iCloud/Yandex может завершить >=400 раньше этого шага; не заменять его ошибку.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| missing | До PUT | CalDAV: событие не найдено | Для move отсутствует ресурс |
| etag | До PUT | CalDAV не вернул ETag; безопасная запись невозможна | ETag отсутствует |
| http | non-2xx | CalDAV: HTTP N; при 412 добавляется требование перечитать | checked response; status приложен |
| dependency | Разный | Из resolve/transport/compute | Ошибка данных, сети, бюджета |
