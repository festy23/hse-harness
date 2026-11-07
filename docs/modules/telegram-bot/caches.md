# Кэши Telegram Bot

Все кэши in-memory; Redis не использовать.

| Кэш | Ключ и значение | Время жизни и размер | Формирование и инвалидация |
|---|---|---|---|
| `TelegramBot.sends` | deliveryId → Promise<void> | До settlement; число одновременных уникальных доставок, лимит не задан | Вставить при первом send; одинаковый id разделяет Promise; удалить в finally |
| `TelegramBot.retryAt` | Один UTC epoch ms | До уничтожения экземпляра; 1 число | Максимум наблюдавшихся валидных retry_after; перед запросом брать max с сохранённым botRetryAt |
| Coordinator.entries | update_id → `{update,state,retryAt,callback}` | До сохранённого продвижения offset; максимум 100 записей | observe игнорирует дубли и старые update; advance удаляет завершённый префикс |
| Coordinator.jobs | Set<Promise<void>> | До завершения каждого lifecycle.run | Добавлять при запуске, удалять finally; idle ожидает все |
| Coordinator.tail | Promise<void> | Весь экземпляр; 1 Promise | Последняя медленная задача сериализует следующие |

При рестарте entries и sends не восстанавливать. Telegram повторно отдаёт неподтверждённые updates; outbox и ownerUpdates обеспечивают сохранённую часть дедупликации. retryAt не должен обходить сохранённый cooldown.
