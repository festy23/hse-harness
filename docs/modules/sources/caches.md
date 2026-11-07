# Кэши Sources

Все перечисленные ресурсы in-memory; Redis и межпроцессного sharing нет.

| Ресурс | Форма | Время жизни, размер | Формирование и инвалидация |
|---|---|---|---|
| TelegramSource.client/candidate | TelegramClient | До close/переподключения; до 1 опубликованного и 1 кандидата | Успешный GetState и разрешение всех peers публикуют candidate; failed/aborted кандидат уничтожается |
| peers | Map<chatId,InputPeer> | До следующего успешного connect; размер число выбранных чатов | Из полного списка dialogs; addChat дополняет после durable config save |
| connecting | `{promise,scope,waiters,settled}` | Один общий connect attempt | Конкурентные connect разделяют попытку; последняя отмена waiter прерывает её; finally удаляет |
| authFailure | `{sessionHash,error}` | До смены hash прочитанной session или уничтожения экземпляра | После authentication ошибки не повторять сеть для той же session |
| failures/retryAt | Счётчик + UTC epoch ms | До успеха connect; 2 числа | Backoff 1/5/15/60 секунд; успех обнуляет |
| generation | number | Срок жизни TelegramSource | Увеличивать connectAttempt и close; старый candidate не публиковать |
| floodWaits | WeakMap<TelegramClient,Map<className,monotonicUntil>> | До GC клиента; число встреченных классов RPC | seconds ошибки ограничить 86400 сек; запросы того же класса до until отклонять без сети; expiry проверять сравнением, запись не удалять |
| guarded IMAP | WeakMap<client,{error?:Error}> | До GC клиента; 1 запись на соединение | Первый error запоминать навсегда для экземпляра; следующий poll создаёт новый client |

Списки found/before сканирования не считать только кэшем: их прогресс сохраняется в cursors. Отказ/утрата peers требует connect и не продвигает source cursors.
