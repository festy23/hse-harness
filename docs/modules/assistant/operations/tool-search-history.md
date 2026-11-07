# search_history

## Метод

Pi tool `search_history`; [общая оболочка](tools.md).

## Описание

Поиск исходных записей штатной памяти.

## Ресурсы

Pi.manager.getEntries(), sticky persistence guard, yieldIfNeeded.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| query | string | Да | 2..150 символов |

## Выходные параметры

string[]: максимум 8 сериализованных записей, каждая первые 12000 символов JSON.

## Результат в случае успеха

Вернуть результат в [общей JSON text оболочке](tools.md).

## Результат в случае ошибки

Отклонить execute Promise; завершённые внешние/локальные действия не откатывать.

## Алгоритм работы

1. Проверить Pi persistenceFailure; при наличии выбросить её. needle=query.toLowerCase(); entries=manager.getEntries().
2. Сканировать entries от последней к первой, пока не найдено 8 совпадений. Перед каждой итерацией вызвать yieldIfNeeded с ctx.signal. JSON.stringify(entry).toLowerCase().includes(needle) определяет совпадение; тип записи не фильтровать.
3. При совпадении добавить serialized.slice(0,12000). В конце reverse массива, чтобы вернуть найденные последние записи в хронологическом порядке. При отсутствии совпадений вернуть []. Полнотекстовый индекс, fuzzy search и поиск только по compaction summary не применять.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| durability | OperationError | Не удалось сохранить штатное состояние Pi | Sticky failure |
| dependency | exception | Из JSON/yield | Сериализация/отмена |
