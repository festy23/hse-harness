# Кэши и процессное состояние Assistant

| Ресурс | Тип/форма | Время жизни и размер | Формирование/инвалидация |
|---|---|---|---|
| session/manager | In-memory AgentSession/SessionManager | Один активный экземпляр; до dispose/повторного open | Открыть по sessionPath или создать; dispose освобождает session |
| persistenceFailure | In-memory OperationError? | До уничтожения PiAssistant; одна ошибка | Первый append/fsync сбой фиксирует durability; явного сброса нет |
| guardedManagers | In-memory WeakSet<SessionManager> | До GC менеджера | Помечает установленные guards; не должен повторно оборачивать append |
| ownerTurn/turnId | In-memory boolean/string | Текущий prompt/queue item; явного сброса после prompt нет | turnId задаёт worker до recovery/prompt; ownerTurn задаёт prompt |
| keys/failed | In-memory Map<toolCallId,key>/Set<key> | Один prompt, объём по tool calls | Подписка events, освобождается после prompt; failed фиксирует последние исходы важных действий |

Поисковый индекс истории и отдельный кэш результатов модели отсутствуют. Восстановление ответа должно использовать долговечные записи Pi/queue.
