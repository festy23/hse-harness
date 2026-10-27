# Файловые ресурсы Core

## Размещение и запись

`dataDir()` определяет каталог `operations.json` и `service.lock`.
`secretsDir()` определяет каталог credentials; форматы credentials принадлежат
[CLI](../../cli/database/README.md). Каталоги создаются с mode `0700`, новые
снимки operations и secret-файлы — `0600`. mkdir не меняет mode уже существующих
каталогов. Сохранение файла заменяет прежний inode новым temporary-файлом с mode 0600;
отдельного chmod старого файла нет.
PostgreSQL, Redis и SQL-транзакции отсутствуют. Порядок commit файла определён в
[сохранении](../operations/persistence.md).

## Operations state

Формат — JSON object. Все поля без отметки `?` обязательны для создаваемого
состояния; загрузчик старых форматов дополняет отсутствующие поля начальными значениями,
но обязательность проверяет только в пределах алгоритма `load`.

| Поле | Тип и начальное значение | Назначение |
|---|---|---|
| `schemaVersion` | literal `2` | Версия writable state |
| `sessionPath?` | string | Путь сессии Pi |
| `botOffset` | safe integer ≥ 0; `0` | Следующий offset getUpdates |
| `botIdentity?` | string | `telegram:<1–20 digits>` либо `telegram:opaque:<24 lowercase hex>` |
| `botRetryAt?` | safe integer ≥ 0 | Запрет Bot API запросов до Unix milliseconds |
| `cursors` | map string → string; `{}` | Курсоры источников и JSON-строки служебного прогресса |
| `queue` | QueueItem[]; `[]` | Очередь входных порций, owner messages и сводок |
| `ownerUpdates` | map string → true; `{}` | Принятые owner update IDs с bot identity |
| `outbox` | map delivery ID → Delivery; `{}` | Квитанции частей исходящих сообщений |
| `missedDigests` | map digest ID → milliseconds; `{}` | Просроченные окна сводок |
| `taskOperations?` | map operation ID → TaskOperation; `{}` | Журнал календарных изменений |
| `seen` | map Source.id → SHA-256; `{}` | Последний принятый fingerprint источника |
| `jobs` | Job[]; `[]` | Напоминания |
| `delivered` | map delivery ID → milliseconds; `{}` | Квитанции уведомлений и сводок |
| `approvals` | Approval[]; `[]` | Подтверждения внешних действий |
| `calendarTokens` | map collection key → string; `{}` | Токены синхронизации календарей |
| `health` | map component → string; `{}` | `starting`, `ok`, `unavailable` |
| `bootstrapFinished` | boolean; `false` | Разрешение напоминаний после `/ready` |
| `notices` | map notice ID → text; `{}` | Сохранённые уведомления |
| `npmUpdates?` | NpmUpdateState | [Протокол обновлений](../../runtime/README.md) |

## QueueItem

| Поле | Тип | Правило |
|---|---|---|
| `id` | string | UUID порции, `owner:<dedupe key>` или ID сводки |
| `sources` | Source[] | До четырёх фрагментов в новой порции Store.enqueue; owner item содержит `[]` |
| `ownerText?` | string | Текст owner message, в том числе пересылки |
| `forwarded?` | boolean | `true` для Telegram forward_origin; отсутствие сохраняет legacy owner semantics |
| `digest?` | string | Вид сводки |
| `phase?` | `prompting` / `answer` | Сохранённая стадия обработки |
| `answer?` | string | Финальный ответ для возобновления отправки |

## Source, Task, Lesson, Job

| Структура | Поля |
|---|---|
| Source | `id:string`, `kind:telegram/mail/web/owner/calendar`, `text:string`, `date:string`; optional `author`, `url`, `replyTo`:string, `deleted:boolean` |
| Task | `id`, `title`, `course`:string; `status:open/done/submitted/cancelled`; optional `deadline:string`; `deadlineBasis:explicit/personal-date-rule/schedule/unknown`; `sources:string[]`, `disputed:boolean`, `notes:string` |
| Lesson | `id`, `title`, `start`, `end`:string; optional `allDay:boolean` |
| Job | `id:string`, `taskId:string`, `due:number` Unix milliseconds, `text:string` |

Правила дат, идентификаторов и напоминаний определены в
[доменных преобразованиях](../operations/domain.md). Task с дедлайном хранится
через календарный модуль; отдельной полной таблицы всех Task в operations нет.

## Delivery

| Поле | Тип | Формирование |
|---|---|---|
| `text` | string | Исходный текст первого вызова с delivery ID |
| `buttons?` | unknown | Сохранённая inline keyboard |
| `chunks` | Chunk[] | По одному элементу на исходящую часть |
| `created` | number | Date.now() при создании |
| `ambiguous?` | boolean | `true`, если повторяется часть с неопределённой доставкой |
| `Chunk.state` | `pending/sending/sent` | [Доставка Bot API](../../telegram-bot/README.md) |
| `Chunk.messageId?` | number | Telegram message_id успешной отправки |

## Approval

| Поле | Тип |
|---|---|
| `id` | UUID string |
| `kind` | `question/lesson` |
| `payload` | object; optional strings `chat`, `text`, `lessonId`, `start`, `end`, `preview` |
| `randomId` | Signed int64 в десятичной строке |
| `state` | `pending/sending/sent/rejected` |
| `created` | milliseconds |
| `sent?` | milliseconds |
| `messageId?` | string |
| `answered?`, `notified?` | boolean |

Создание, разрешение и повтор определены в [Study](../../study/README.md).

## TaskOperation

| Поле | Тип |
|---|---|
| `id`, `taskId` | string; ключ map равен `id` |
| `beforeTask?`, `desiredTask` | Task; их id должны совпадать с taskId |
| `phase` | `pending/applied/notified/conflict/superseded` |
| `notify` | boolean |
| `created` | finite number |
| `supersededBy?` | string |
| `writeAttempted?` | boolean |

Переходы и конкурентная проверка определены в [Study](../../study/README.md).

## NpmUpdateState

Поля: optional `botIdentity:string`, `checkedAt:number`, `lastOfferedAt:number`,
`latest:{version,integrity}`, `offer:{version,integrity,id}`,
`pendingNotice:{id,text,offerId,version}`,
`request:{version,integrity,id,workerId,phase,created}`.
`request.phase` принадлежит `authorizing/pending/installing/awaiting-apply/completed/failed`.
`version` — stable release, integrity — `sha512-` плюс 86 base64 символов и `==`.
Переходы определены в [Runtime](../../runtime/README.md).

## Writer lock

`service.lock` — JSON `{pid:number,nonce:UUID,workerId?:string,startedAt:ISO string}`.
`<filename>.recovery` является эксклюзивным маркером восстановления. Алгоритм
проверки процесса, сравнения содержимого и удаления описан в
[блокировках](../operations/locking.md).

Источник: [store.ts](../../../../src/store.ts), [domain.ts](../../../../src/domain.ts).
