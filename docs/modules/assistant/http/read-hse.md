# Чтение HSE

## Метод

Исходящий `GET {url}`, функция readHse(value,offset=0,parent?).

## Описание

Чтение текстовой официальной страницы с постраничной выдачей текста.

## Ресурсы

Fetch, [Core HTML compute](../../core/operations/compute.md), [tools.ts](../../../../src/tools.ts).

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| url | URL | path/query | Да | Исходный либо redirected HTTPS URL hse.ru |
| offset | integer | Локальный аргумент | Нет | Смещение текста в UTF-16 символах; не отправлять серверу |
| headers/body | Отсутствуют | header/body | Нет | Специальные заголовки/тело не задавать |

## Выходные параметры

| Поле результата | Источник или правило формирования |
|---|---|
| url | Финальный url.href |
| text | Полный HTML-to-text результат.slice(offset,offset+25000) |
| totalCharacters | Полная длина текста |
| nextOffset | offset+25000, только если это значение < полной длины; иначе undefined, JSON wrapper поле опускает |
| links | Уникальные разрешённые ссылки в порядке появления, максимум 200 |

## Результат в случае успеха

HTTP 2xx с Content-Type, содержащим `text/` без учёта регистра. Вернуть результат после чтения полного документа и compute; offset не ограничивает сетевое чтение.

## Результат в случае ошибки

Отклонить Promise. Неполную страницу не возвращать и правило предмета не считать проверенным.

## Алгоритм работы

1. В request operation budget=45000 ms, ограниченном parent, проверить URL: protocol=https:, без username/password/port, hostname соответствует `^(?:[a-z0-9-]+\.)*hse\.ru$` без учёта регистра. Query/hash этим правилом не запрещены.
2. Выполнить до 5 fetch-попыток с redirect=manual, signal=any(ctx.signal,timeout(20000)). При 300..399 отменить body, вычислить Location??'' относительно текущего URL, повторить проверку URL, перейти к следующей попытке. После пяти redirects завершить redirect-limit. Для иных non-2xx завершить http без чтения error body.
3. Если Content-Type не содержит text/, завершить non-text. Читать body.getReader последовательно; суммировать byteLength, при size>1000000 завершить payload-limit. В finally всегда reader.cancel().
4. Buffer.concat(chunks).toString('utf8') передать runCompute({type:'html',mode:'hse',html,baseUrl:url.href},ctx). Compute должен потребовать размер UTF-8 ≤1000000 bytes, преобразовать body через html-to-text без wordwrap и выделить ссылки по href в одинарных/двойных кавычках. Каждую ссылку разрешить относительно baseUrl, оставить только HTTPS hse.ru без user/password/port; invalid URL пропустить; собирать Set до 200.
5. Вернуть поля таблицы. Дополнительных HTTP retry, загрузки вложений или переходов по найденным links не выполнять.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| url | Нет/3xx | Разрешены только HTTPS страницы hse.ru | Неразрешённый URL |
| http | non-2xx кроме redirect | HSE: HTTP N | HTTP ошибка |
| non-text | 2xx | Страница не текстовая; правило остается непроверенным | Неподходящий MIME |
| payload-limit | 2xx | Слишком большая страница / Слишком большой HTML документ | >1000000 bytes |
| redirect-limit | 3xx | Слишком много перенаправлений HSE | Исчерпаны 5 попыток |
| dependency | Нет/2xx | Из fetch/compute/Core | Отмена, бюджет, decode/convert |
