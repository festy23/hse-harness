# getUpdates

## Метод

POST `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates`. Внешний исходящий метод.

## Описание

Прочитать очередь сообщений и callbacks с сохранённого offset.

## Ресурсы

[Transport](../operations/transport.md), [настройки](../settings.md), Telegram Bot API.

## Входные параметры

| Название | Расположение | Тип | Обязательность | Правило формирования |
|---|---|---|---|---|
| offset | body | number | Да | Store.state.botOffset |
| timeout | body | number | Да | 25 секунд |
| allowed_updates | body | string[] | Да | [message, callback_query] |
| Content-Type | header | string | Да | application/json |

## Выходные параметры

```yaml
result:
  type: array
  items:
    update_id: {type: number, required: true}
    message:
      required: false
      message_id: {type: number, required: true}
      chat:
        id: {type: number, required: true}
        type: {type: string, required: true}
      from:
        required: false
        id: {type: number, required: true}
      text: {type: string, required: false}
      forward_origin: {type: unknown, required: false}
    callback_query:
      required: false
      id: {type: string, required: true}
      from:
        id: {type: number, required: true}
      message:
        required: false
        chat:
          id: {type: number, required: true}
          type: {type: string, required: true}
      data: {type: string, required: false}
```

Это потребляемый TypeScript контракт; адаптер не валидирует result как массив и не проверяет элементы глубоко. Неиспользуемые Telegram поля не влияют на handler.

## Результат в случае успеха

HTTP 200 с ok=true и result; локально допускается любой response.ok при выполнении [проверок transport](../operations/transport.md).

## Результат в случае ошибки

Отклонить Promise ошибкой transport; самостоятельно не повторять запрос.

## Алгоритм работы

1. Сформировать все поля запроса по таблице; остальные параметры Telegram опустить.
2. Выполнить [call](../operations/transport.md) с методом `getUpdates` и внешним signal при наличии. Timeout 40000 ms; cooldown проверяется до сети.
3. Вернуть result вызывающему; при ошибке завершить текущую попытку и передать её вызывающему.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| BotApiRejection | Provider status / локальный 429 | Description провайдера или cooldown | Применить сохранение retry_after из transport |
| transport / protocol | Нет | Ошибка transport | Включает timeout, abort, JSON, некорректный результат |

## Протокол

[Официальный getUpdates](https://core.telegram.org/bots/api#getupdates).
