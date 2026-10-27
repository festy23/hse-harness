# Настройки Sources

| Название | Тип | Обязательность | Значение по умолчанию | Описание |
|---|---|---|---|---|
| config.chats | TelegramChat[] | Да | Нет | Разрешённые Telegram чаты, канонические ID |
| config.folders | string[] | Да | Нет | При пустом массиве обнаруживать папки, исключив Trash/Junk/Drafts |
| config.ownerId | number | Да | Нет | Проверка владельца при durable добавлении чата |
| TELEGRAM_API_ID | secret string → Number | Да для createClient | Нет | MTProto apiId |
| TELEGRAM_API_HASH | secret string | Да для createClient | Нет | MTProto apiHash |
| TELEGRAM_TRANSPORT | tcp или wss | Нет | wss при proxy config file, иначе tcp | Другие значения отвергать |
| TELEGRAM_PROXY_CONFIG | path env | Нет | HSE_TELEGRAM_PROXY_FILE | JSON прокси имеет приоритет над proxy URL |
| HSE_TELEGRAM_PROXY_FILE | path env | Нет | Нет | Совместимый путь proxy config |
| TELEGRAM_HTTP_PROXY | URL env | Нет | HTTPS_PROXY | Только для WSS |
| HTTPS_PROXY | URL env | Нет | Нет | Резервный proxy URL WSS |
| STUDY_CONFIG | path env | Нет | config.local.json | addChat, если options.configPath не задан |
| YANDEX_ADDRESS | secret string | Для mail | Нет | IMAP username |
| YANDEX_APP_PASSWORD | secret string | Для mail | Нет | IMAP password |
| STUDY_MAX_TEXT_BYTES | safe integer env | Нет | 2000000 bytes | Минимум 6000; читать при наличии текстовой части |
| HISTORY_FROM | ISO string, константа | Да | 2026-09-01T00:00:00+03:00 | Включительная нижняя граница ingest |
| pollSeconds | number config | Нет | 60 секунд, минимум 15 | Пауза завершённого sourceLoop; незавершённый slice — 1 секунда |

Использовать [Core budgets](../core/settings.md): rpc 30000, connect 120000, telegramSlice 60000, history/question 45000, addChat 120000, mailSlice 120000, message 45000, cleanup 5000 ms. Дочерний контекст ограничивать оставшимся временем родительского. options.createClient, options.now и options.configPath — необязательные зависимости TelegramSource; default createTelegramClient, Date.now и путь env соответственно. continuing по умолчанию возвращает true; worker передаёт lifecycle.accepting.

Фиксированные IMAP параметры: imap.yandex.ru:993, TLS secure=true, logger=false, connectionTimeout=20000 и socketTimeout=30000 ms. MTProto connectionRetries=3, reconnectRetries=3, timeout=15 секунд, logging NONE; connect дополнительно ограничен таймером 45000 ms; WSS proxy handshakeTimeout=15000 ms.
