# Ресурсы Calendar

Физический формат общего файла состояния должен соответствовать [Core](../../core/database/README.md). Модуль не должен вводить отдельную БД, PostgreSQL, Redis или SQL-схему.

| Ресурс | Ключ | Значение и писатель |
|---|---|---|
| `state.calendarTokens` | `timetable.identity` | Непустой cursor последнего завершённого `changes`; syncSchedule должен удалить ключ при отсутствии cursor |
| `state.cursors` | `calendarSnapshot:${timetable.identity}` | JSON-массив ID неотменённых событий последнего снимка; syncSchedule |
| `state.queue`, записи источников и дедупликация | Через `Store.enqueue` | Порции до 20 календарных Source; формат Core |
| `${secretsDir()}/google.json` | Один файл | JSON `{access_token:string,refresh_token:string,expires_at:number}`; expires_at — epoch ms; OAuth refresh должен заменять access_token/expires_at через writeSecret |
| Удалённый календарь `agent` | SHA-256 UTF-8 task.id, первые 40 hex-символов | Событие с сериализованным Task; [отображение](../operations/study-calendar.md) |
| Удалённый календарь `timetable` | ID провайдера/CalDAV resource ID | События расписания; изменение только через одобренный перенос |

Запись queue-порций должна предшествовать записи snapshot/cursor. Ошибка между порциями должна оставлять уже сохранённые порции; следующий цикл должен полагаться на дедупликацию Store. Удалённая запись и локальный Store не образуют общей транзакции.
