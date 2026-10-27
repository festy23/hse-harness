# Доменные преобразования

## Ресурсы и параметры

Операции используют [Task, Source, Lesson и Job](../database/README.md),
TZ=`Europe/Moscow`, HISTORY_FROM=`2026-09-01T00:00:00+03:00`.
Сетевых вызовов и файловых записей нет.

## deadline(value:string)

### Алгоритм работы

1. Если value соответствует `YYYY-MM-DD`, создать Date(value+'T00:00:00+03:00').
   Требовать finite instant и moscowDate(instant)===value. Иначе завершить
   `Некорректная дата`.
2. Для date-only вернуть `{value:instant.toISOString(),basis:'personal-date-rule'}`.
3. Для остальных строк требовать ISO date-time с часом, минутой, optional seconds/
   fractional seconds и обязательным Z либо signed HH:MM offset. Иначе завершить
   `Укажите дату YYYY-MM-DD или ISO дату с часовым поясом`.
4. Создать instant и отдельный UTC day из datePart. Требовать finite даты,
   равенство нормализованного UTC day datePart, часы ≤23, минуты ≤59; иначе
   `Некорректное время`. Дополнительная проверка seconds сверх Date parser отсутствует.
5. Вернуть ISO UTC value и basis=`explicit`.

### Формирование результата

| Поле | Источник |
|---|---|
| value | Date.toISOString нормализованного instant |
| basis | personal-date-rule для date-only, explicit для date-time |

## validateTask(t:Task)

1. Требовать id по `^[a-z0-9_-]{1,80}$` и непустые trim(title/course); иначе
   `Нужны стабильный id, название и предмет`.
2. Требовать status open/done/submitted/cancelled, иначе `Неизвестный статус`.
3. Требовать deadlineBasis explicit/personal-date-rule/schedule/unknown,
   иначе `Неизвестное основание срока`.
4. При truthy deadline создать новый Task с deadline=deadline(t.deadline).value.
   Входной deadlineBasis сохранить; basis функции deadline не подменяет его.
5. Требовать sources.length>0, иначе `Нужен хотя бы один источник`. Вернуть Task.
   Функция принимает типизированный Task и не служит полной unknown JSON-валидацией
   типов notes/disputed и каждого элемента sources.

## hash / taskVersion

hash(text) возвращает SHA-256 UTF-8 текста в lowercase hex.
taskVersion(t) вычисляет hash(JSON.stringify([id,title,course,status,deadline,disputed])).
Изменение notes, sources и deadlineBasis не меняет эту версию при прочих равных.

## reminderJobs(t:Task)

1. При отсутствии deadline либо status submitted/cancelled вернуть [].
2. Для offsets 72,24,1 часов создать jobs в этом порядке.
3. due=Date(deadline).valueOf()-hours*3600000; job ID=`task.id:hash(deadline):hours`.
4. Для labels «три дня», «день», «час» соответственно сформировать text:
   `До сдачи осталось <label>: <course> — <title>\nСрок: <prettyTime(deadline)>`.
   Последовательно дописать суффиксы: при status=done —
   `\nРабота сделана, осталось сдать.`, при disputed=true —
   `\nСрок спорный: пока ориентируемся на самый ранний.`, при
   deadlineBasis=personal-date-rule — `\nВремя определено твоим правилом даты без часа.`.
   Для ложных условий соответствующий суффикс опустить; разделители сверх указанных
   newline не добавлять.

| Поле Job | Источник |
|---|---|
| id | Стабильный ID по taskId/deadline/hours |
| taskId | t.id |
| due | Вычисленные Unix milliseconds |
| text | Сформированное напоминание |

## Отображение времени

moscowDate(at) должен вернуть дату ISO после прибавления 3h к Unix milliseconds.
moscowHour(at) должен вернуть UTC hour той же сдвинутой даты.
prettyTime(value) использует Intl.DateTimeFormat ru-RU, Europe/Moscow,
dateStyle=medium, timeStyle=short.

Источник: [domain.ts](../../../../src/domain.ts).
