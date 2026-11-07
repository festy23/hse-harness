# Постоянные ресурсы Sources

Физическое состояние хранить в [общем Store](../../core/database/README.md). PostgreSQL/Redis не использовать. Ни MTProto, ни IMAP запрос не входит в файловую транзакцию. Сначала сохранять Source через [enqueue](../../core/operations/ingestion.md), затем фиксировать соответствующий cursor; после сбоя повтор допускает тот же источник и опирается на Core.seen.

## Cursors

Все значения State.cursors являются строками; отсутствующий ключ означает отсутствие соответствующей контрольной точки.

| Ключ | Строковое значение | Запись и смысл |
|---|---|---|
| tgState | JSON object с числовыми `pts,qts,date,seq`; после прямого fresh также `unreadCount,className` | Общая MTProto позиция; GetState до первичного сканирования, затем state/intermediateState из difference |
| tgChannel:<chat> | String(pts) | Канальная позиция; GetFullChannel перед первичной историей, затем channel difference |
| tgHistory:<chat> | `1` | Успешное завершение доступной истории до HISTORY_FROM; существование truthy значения означает loaded |
| tgScan:<chat> | JSON `{offset:number,found:number[],before:number[]}` | Возобновляемое полное сканирование; before — ID ранее seen, found — все обнаруженные ID, offset — следующая страница |
| tgResync | JSON `{fresh:CommonState,chats:string[],done:string[],noticeSent?:boolean}` | Неполный общий поток; fresh фиксируется до reconciliation, done накапливается после каждого чата |
| tgResyncChannel:<chat> | JSON `{pts:number,noticeSent?:boolean}` | Неполный канальный поток; чтение также принимает устаревший JSON number как pts |
| mail:<folder> | `<uidValidity>:<uid>` | Последнее полностью обработанное письмо папки |
| sourceProgress:<name> | JSON состояния Core progress | Записывается общим sourceLoop, не самим адаптером |

CommonState требует pts,qts,date,seq. При первом DifferenceTooLong fresh сохраняется непосредственно из Api.updates.State и JSON содержит также unreadCount и className="updates.State". Возобновление tgResync восстанавливает fresh только из четырёх числовых полей, отбрасывая остальные. Немедленно завершённая сверка записывает в tgState исходный свежий объект; DifferenceEmpty сохраняет дополнительные поля через spread, полная Difference/DifferenceSlice снова записывает только четыре числовых поля.

Парсинг tgScan проверяет record, requiredNumber offset, numberArray found/before. tgResync проверяет fresh через requiredNumber для четырёх полей, stringArray chats/done, optionalBoolean noticeSent. tgResyncChannel проверяет requiredNumber pts и optionalBoolean noticeSent. tgState читается JSON.parse без дополнительной проверки shape в commonDifference. mail cursor разделяется по `:`; совпадающий uidValidity даёт Number(previous[1]), несовпадение — last=0.

## Sources и seen

Схему Source определяет Core. Telegram использует id `tg:<chat>:<messageId>`, почта `mail:<sha256(messageId)>`. seen является общим журналом версий; удаление Telegram enqueue допускается только для ID, truthy присутствующего в seen. Адаптер не удаляет элемент seen при обнаружении удаления.

## Session и конфигурация

Сохранённый MTProto StringSession читать из `<secretsDir>/telegram.session` как UTF-8 и trim; обновление session выполняет CLI. Секреты и accessHash в Source не включать. Перечень chats хранить в config; успешное addChat сначала выполняет защищённую запись файла, затем обновляет config.chats и peers в памяти. Формат chat `{id:string,title:string,allowQuestions?:boolean}`. При динамическом добавлении записывать allowQuestions=false. Существующий chat сохранять без изменения его полей. Подробный порядок — [chats](../operations/chats.md).
