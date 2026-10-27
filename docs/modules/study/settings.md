# Настройки Study

| Название | Тип | Обязательность | Значение по умолчанию | Описание |
|---|---|---|---|---|
| TZ | Константа string | Да | Europe/Moscow | Календарный день/час и подписи |
| Reminder offsets | Константа hours[] | Да | 72,24,1 | Отступы до дедлайна |
| Digest starts | Константа hours[] | Да | 10,20 | Утренняя/вечерняя сводка |
| Digest window | Константа hours | Да | 2 | Устаревание при now>=start+2h |
| Late threshold | Константа ms | Да | 120000 | Позднее напоминание/сводка при задержке строго больше |
| Approval validity | Константа ms | Да | 86400000 | При decide отклонить при возрасте >суток; propose dedupe только <суток |
| Question follow-up | Константа ms | Да | 86400000 | Нет ответа сутки и более |
| Parallelism | Константа integer | Да | 4 | Tasks, notices, recover approvals |
| allowedChats | Set<string> | Да | config.chats с allowQuestions!==false | Фиксируется при сборке Approvals |
| timers interval | Константа ms | Да | 10000 | Локальные уведомления и одобрения |
| pollSeconds | number | Из Core | Из Core | Восстановление работ/обновление jobs |

Бюджеты должны использовать [Core settings](../core/settings.md): question=45000 ms, calendarMutation=90000 ms, calendarScan=120000 ms. У задач нет собственного quiet-hours окна; срочные notices должны допускаться ночью.
