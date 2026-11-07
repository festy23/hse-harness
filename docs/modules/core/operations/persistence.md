# Сохранение и загрузка состояния

## Метод

`Store.load(options?)`, `Store.save()`, `Store.flush()`, `writeSecret(path, content)`.

## Описание

Файловая фиксация [operations state](../database/README.md) и отдельных секретов.

## Ресурсы

`operations.json`, UUID temporary sibling, каталог Store.dir, in-memory state,
requestedRevision, durableRevision, waiters, writeFailure.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| Store.dir | string | Да | Каталог состояния |
| options.readOnly | boolean | Нет | Запрет создания каталога при load |
| path | string | Для writeSecret | Целевой файл |
| content | string | Для writeSecret | Полное новое содержимое |

## Выходные параметры

Методы возвращают Promise<void>. У load результатом также является State в памяти;
у save — durable revision не ниже revision конкретного вызова; flush ожидает только
revision, существующую на момент вызова.

## Алгоритм работы load

1. Если readOnly не true, создать Store.dir рекурсивно с mode 0700.
2. Прочитать UTF-8 operations.json и JSON.parse. ENOENT завершает загрузку,
   сохранив текущее значение this.state (пустое у нового Store); остальные ошибки
   чтения и JSON завершают загрузку ошибкой.
3. Требовать object, не null и не array. При наличии npmUpdates проверить object,
   finite checkedAt/lastOfferedAt и string botIdentity при наличии. Для truthy
   pendingNotice требовать string id/text/offerId и stable version; falsy значение
   этого поля отдельно не отвергать. Для latest/offer/request при `!== undefined`
   требовать truthy объект с stable version и integrity по
   `^sha512-[A-Za-z0-9+/]{86}==$`. Для offer/request id применить
   `^[a-f0-9-]{36}$`; для truthy request дополнительно проверить допустимую phase,
   string workerId и finite created. Stable version — строка длиной ≤64,
   соответствующая `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`.
   Проверка npmUpdates не содержит отдельного запрета Array.
4. Разрешить schemaVersion absent, 1 или 2. Требовать safe nonnegative botOffset
   и arrays queue/jobs/approvals. Проверить botIdentity и botRetryAt по схеме.
5. При наличии cursors/seen/delivered/calendarTokens/health/notices/ownerUpdates/
   outbox/missedDigests/taskOperations требовать non-null non-array object.
6. Для queue требовать item object, string id, array sources, boolean forwarded
   при наличии, phase prompting/answer при наличии и string answer при наличии.
   Вложенные Source и ownerText этот шаг глубоко не валидирует.
7. Для delivery требовать string text, array chunks и states pending/sending/sent.
   Типы messageId/buttons/created этим шагом не проверяются.
8. Для taskOperations проверить совпадение ключа/id, string taskId, допустимую
   phase, boolean notify, finite created, optional boolean writeAttempted.
   Вызвать validateTask для desiredTask и truthy beforeTask, потребовать
   совпадения их id с taskId. Возвращаемые validateTask объекты не присваивать обратно:
   эта загрузка проверяет даты, но не записывает их нормализованный вариант.
9. Установить state как spread empty(), затем прочитанные поля, затем schemaVersion=2.
   Файл на диске не переписывать до первого save. Дополнительные JSON-поля не удалять.

## Алгоритм работы save/flush

1. При установленной writeFailure немедленно отклонить Promise той же ошибкой.
2. save увеличивает requestedRevision на 1, ставит pendingWrite=true и создаёт
   waiter своей revision. Если writer не работает, поставить writing=true и
   запланировать writePending в queueMicrotask.
3. Writer сбрасывает pendingWrite, запоминает текущую requestedRevision и синхронно
   сериализует весь текущий state через JSON.stringify. Несколько save могут
   объединяться одним снимком; отдельно сохранённой копии на каждый вызов нет.
4. Создать `operations.json.<UUID>` с `wx`, mode 0600; записать snapshot, выполнить
   file.sync, закрыть handle в finally. Rename temporary в operations.json.
5. Открыть Store.dir для чтения, выполнить directory.sync, закрыть handle.
   Только после этого установить durableRevision и разрешить waiters до этой revision.
6. При pendingWrite=true повторить шаг 3; иначе снять writing.
7. Любая ошибка сериализации/записи фиксирует OperationError durability с текстом
   `Не удалось сохранить состояние операций` (либо сохраняет уже полученную durability),
   сбрасывает pendingWrite и отклоняет всех waiters. Последующие save/flush должны
   отклоняться; автоматического сброса fatal нет. Мутации state в памяти не откатываются.
8. flush должен дождаться requestedRevision, считанной при его вызове; если она
   уже durable, вернуть успешно. Новые изменения без save не записывать.

## Алгоритм работы writeSecret

1. Создать `<path>.<UUID>` с wx/0600, записать content, file.sync и закрыть handle.
2. Rename temporary в path. Успех вернуть после rename; directory.sync этот метод
   не выполняет. Ошибка передаётся вызывающей стороне; retry и удаление temporary
   при ошибке не предусмотрены.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| invalid-state | rejected load | Invalid operations state / Invalid queue / Invalid delivery receipt / Invalid calendar operation | Нарушен проверяемый формат |
| unsupported-schema | rejected load | Unsupported operations format | Версия не absent/1/2 |
| durability | fatal OperationError | Не удалось сохранить состояние операций | Writer не подтвердил durable revision |
| filesystem/JSON | rejected | Ошибка исходного API | Чтение/parse/load или writeSecret не завершились |

Успех локального save не подтверждает внешнюю отправку или изменение календаря.
Источник: [store.ts](../../../../src/store.ts).
