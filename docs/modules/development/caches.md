# Кэши

| Тип | Ключ и значение | Срок жизни и размер | Формирование и инвалидация |
|---|---|---|---|
| In-memory harness | Текст lockfile, parsed package/lock, SHA-256 | Один запуск; размер входных JSON | Чтение при prepare; сброс при выходе |
| In-memory manifest | Массив fileIdentity и dependency records | Один запуск; число файлов npm inventory | Параллельное вычисление группами по 24; сброс при выходе |
| In-memory demo | `EVENTS: [seconds, bytes][]`, кадры GIF, `emoji_cache[glyph]` | Одна запись; программного лимита нет | PTY и rendering; сброс при завершении процесса |

Файловый stamp harness описан в [ресурсах](database/README.md). GitHub setup-node использует npm download cache по lockfile; после восстановления CI всё равно выполняет npm ci. Redis не используется.
