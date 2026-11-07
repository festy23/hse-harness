# Каталог моделей подписки

## Метод

`GET https://api.openai.com/v1/models`, subscriptionModels(runtime,request=fetch).

## Описание

Пересечение каталога подписки и поддержанных Pi моделей.

## Ресурсы

ModelRuntime.getAuth/getModel/isUsingSubscription, fetch. Авторизацию создаёт [loginSubscription](../operations/session.md).

## Входные параметры

| Название | Тип | Расположение | Обязательность | Описание |
|---|---|---|---|---|
| Authorization | string | header | Да | Bearer + resolution.auth.apiKey подписочного runtime |
| body/query | Отсутствует | body/query | Нет | Не задавать |

## Выходные параметры

| Поле результата элемента | Источник или правило формирования |
|---|---|
| id | response.models[].slug |
| name | display_name при string, иначе slug |

## Результат в случае успеха

HTTP 2xx и JSON object с models array. Вернуть только элементы, для которых runtime.getModel('openai',id) truthy; сохранить исходный порядок и дубли.

## Результат в случае ошибки

Отклонить Promise; не возвращать альтернативный каталог и не включать тело HTTP ошибки в сообщение.

## Алгоритм работы

1. Потребовать runtime.isUsingSubscription('openai'); иначе subscription. Получить await runtime.getAuth('openai'); если !resolution?.auth.apiKey, завершить token.
2. Выполнить GET с Authorization из таблицы, timeout=20000 ms и redirect='error'. Повторы не выполнять.
3. При !response.ok завершить http. Parse JSON, ошибку преобразовать в json. Потребовать object с массивом models; иначе format.
4. Для каждого entry потребовать object с string slug; иначе model-format. Отобразить id/name, затем отфильтровать по runtime.getModel. Пустой результат допускается.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| subscription | До запроса | Требуется подписочный вход: hse-harness model. API-key fallback отключен. | Нет подписки |
| token | До запроса | Подписочный токен недоступен; повторите setup pi | Нет auth apiKey |
| http | non-2xx | Каталог подписки: HTTP N | Ошибка API |
| json | 2xx | Каталог подписки вернул не JSON; проверьте соединение с OpenAI | Malformed JSON |
| format | 2xx | Неизвестный формат каталога подписки | Нет models array |
| model-format | 2xx | Неизвестный формат модели подписки | Нет string slug |
| dependency | Нет | Из runtime/fetch | Сеть/redirect/timeout |
