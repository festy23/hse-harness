# Prompt, восстановление и checkpoint

## Метод

`prompt(text,owner=false) -> Promise<string>`, `completedTurn(turnId,ctx?) -> Promise<string|undefined>`, `checkpoint() -> Promise<void>`.

## Описание

Фиксация завершённого хода модели и восстановление результата после перезапуска.

## Ресурсы

[Pi files/custom entries](../database/README.md), [процессные guards](../caches.md), SDK event stream.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| text | string | Для prompt | Контекст очереди |
| owner | boolean | Нет | false; присваивается ownerTurn |
| turnId | string | Для completedTurn | Искомая порция; prompt читает this.turnId |
| ctx | OperationContext | Нет | Отмена кооперативного сканирования |

## Выходные параметры

prompt — last assistant text либо ''; completedTurn — восстановленный текст либо undefined. Checkpoint результата не возвращает.

## Результат в случае успеха

Обычный prompt должен вернуть ответ только после append результата и fsync. CompletedTurn может создать recovered entry, не вызывая модель и не выполняя собственного checkpoint.

## Результат в случае ошибки

Ответ не подтверждать; queue должна остаться для последующей обработки. Sticky durability должна блокировать последующие операции этого PiAssistant.

## Алгоритм работы

1. Перед guarded операцией проверить persistenceFailure. Guard должен один раз обернуть методы manager: appendMessage, appendThinkingLevelChange, appendModelChange, appendUsage, appendCompaction, appendCustomEntry, appendSessionInfo, appendCustomMessageEntry, appendContextEdit, appendLabelChange. Их синхронное исключение должно установить одну OperationError(durability) и выбросить её, даже если SDK позже перехватит исключение.
2. prompt: проверить failure, установить guards, ownerTurn=owner; append hse-operation-start `{turnId:this.turnId}` до session.prompt.
3. Подписаться на tool_execution_start/end. Только update_task/propose_question/propose_lesson_change/notify_owner должны учитываться как важные действия. Ключ действия=`${toolName}:${args.id??args.chat??args.lessonId??'owner'}`; хранить соответствие toolCallId→key. End с isError добавляет key в failed; успешный end удаляет key. Ошибка одного вызова может быть снята последующим успешным вызовом с тем же ключом.
4. await session.prompt(text). При ошибке проверить sticky failure и пробросить; в finally отписаться. После успеха снова проверить failure. Если последнее message — assistant с stopReason error/aborted, завершить model-incomplete. Если failed не пуст, завершить important-tool.
5. answer=session.getLastAssistantText()??''. Append hse-operation-result `{turnId,answer}`; выполнить Checkpoint; вернуть answer. ownerTurn после выполнения не сбрасывать; последовательность prompt обеспечивает worker.

### CompletedTurn

1. Проверить failure. Без manager вернуть undefined. Снять entries; сканировать с конца к началу, вызывая yieldIfNeeded с ctx.signal. nextOperation сначала entries.length.
2. Если custom result имеет точный turnId и string answer, немедленно вернуть его.
3. Для custom start другого turnId установить nextOperation=index и продолжить назад. Для start искомого turnId просмотреть message entries между ним и nextOperation по возрастанию, кооперативно отдавая event loop.
4. Любой toolResult.isError в этом отрезке означает undefined. Иначе запомнить последнее message. Если оно assistant со stopReason stop или length, соединить текстовые части content без разделителя, guarded append результата `{turnId,answer,recovered:true}`, вернуть answer. Иначе вернуть undefined. При отсутствии start/result вернуть undefined.

### Checkpoint

1. Проверить failure. Последовательно открыть `r+` текущий session file (если есть), secrets/pi-auth.json, secrets/telegram.session, secrets/google.json, data/models.json.
2. ENOENT при open пропустить. Любую другую open-ошибку преобразовать в sticky durability. Для открытого handle выполнить sync и всегда close через finally; любую ошибку sync/close преобразовать в sticky durability.
3. После последнего файла вернуть void. Файлы не создавать и не переписывать; это fsync уже существующих ресурсов.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| durability | OperationError(durability) | Не удалось сохранить штатное состояние Pi | Append/open/sync/close |
| model-incomplete | exception | last.errorMessage ?? Pi не завершил ответ | error/aborted |
| important-tool | exception | Важное действие инструмента не завершено; исходные сообщения оставлены в очереди | failed set непуст |
| dependency | exception | Из SDK/yield | Prompt, отмена поиска |
