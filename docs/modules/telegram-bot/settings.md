# Настройки Telegram Bot

| Название | Тип | Обязательность | Значение по умолчанию | Описание |
|---|---|---|---|---|
| TELEGRAM_BOT_TOKEN | secret string env | Для HTTP вызовов | Нет | Читать через secret непосредственно перед запросом |
| ownerId / TelegramBot.owner | number | Да | Нет | Единственный отправитель и чат назначения |
| TelegramBot.store | Store | Нет для класса, да в worker | undefined | Без Store доставка не имеет постоянного журнала |
| HTTP timeout | ms, константа | Да | 40000 | Объединять с внешним AbortSignal |
| Polling timeout | seconds, константа | Да | 25 | Поле getUpdates.timeout |
| Chunk size | Unicode code points, константа | Да | 3500 | Разбивать regexp /[\s\S]{1,3500}/gu |
| fastConcurrency | integer, параметр coordinator | Нет | 2 | Максимум быстрых задач |
| slowCapacity | integer, параметр coordinator | Нет | 32 | Допущенные медленные задачи, включая ожидающие tail |
| retryMs | ms, параметр coordinator | Нет | 3000 | Задержка повторного handle |
| Callback concurrency | integer, константа | Да | 4 | Одновременные ACK |
| Entries capacity | integer, константа | Да | 100 | Лимит наблюдаемых updates |
| Poll loop sleep | ms, константа | Да | 1000 | Пауза между polling-итерациями |

[Общие budgets](../core/README.md): owner-command 90000 ms, `/tasks` 45000 ms с ограничением родительским deadline.
