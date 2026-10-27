# Файловые операции Runtime

## Метод

Внутрипроцессные `privateDirectory`, `safePath`, `syncDirectory`, `atomicJSON`, `readJSON`, `acquireOwnershipLock`/`ownershipLock`, `acquireLock`, `syncTree`.

## Описание

Обеспечить приватные файлы, атомарную замену JSON и владение одним runtime-писателем.

## Ресурсы

[Файлы и lock](../database/README.md), fs/promises, PID probe.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| path, root | path | по методу | Файл/корень |
| value | JSON value | atomicJSON | Записываемое значение |
| fallback | unknown | нет | Возврат только при ENOENT и наличии второго аргумента readJSON |
| maximumBytes | number | нет | 16 MiB |
| allowMissing | boolean | нет | false |
| identity | object | нет | {} |

## Выходные параметры

`safePath` должен возвращать resolve(path); `readJSON` — JSON.parse файла либо fallback; `acquireOwnershipLock` — record и async release():boolean; `acquireLock` — функцию release с identity `{pid,ownerId}`. Остальные функции должны завершаться без значения.

## Результат в случае успеха

JSON должен быть заменён после fsync файла и rename с последующим fsync родительского каталога. Lock должен оставаться у одного ownerId.

## Результат в случае ошибки

Операция должна отклонять Promise; атомарность нескольких файлов не предоставляется. Ошибка fsync после rename должна сохранять неопределённость подтверждения записи.

## Алгоритм работы

1. `privateDirectory`: создать каталог recursive mode 0700; lstat должен подтвердить directory, отсутствие symlink, совпадение uid при getuid; существующий иной mode исправить chmod 0700. Нарушение завершить STORAGE.
2. `safePath`: resolve root/path; отклонить относительный путь `..`, начинающийся `../`, либо absolute relative. Проверить lstat root и каждого компонента на symlink/чужой uid. При ENOENT и allowMissing вернуть целевой путь, иначе ошибка STORAGE.
3. `readJSON`: lstat path; требовать regular file, не symlink, size <= maximumBytes; прочитать UTF-8, JSON.parse. Только ENOENT при явно переданном fallback должен возвращать fallback. Повреждение JSON должно завершать STORAGE.
4. `atomicJSON`: подготовить приватный parent и safePath с allowMissing; создать `<path>.tmp-<UUID>` через `wx` mode 0600; записать JSON.stringify(value)+LF, sync и close; rename temp→path; sync parent. В finally закрыть handle и удалить temp; игнорировать только ENOENT удаления.
5. `acquireOwnershipLock`: подготовить parent/safePath; сформировать record из identity с заменой pid/ownerId/createdAt. Выполнить не более двух попыток `open(wx,0600)`, записи record+LF, fsync файла, close, fsync parent.
   1. При успехе вернуть record и release. Release должен читать текущий lock с fallback null; при несовпадении ownerId вернуть false; при совпадении unlink+fsync parent и true.
   2. При EEXIST создать `<path>.recovery` через wx. Если recovery уже существует — LOCK. Прочитать старый lock; требовать safe integer pid > 0. `kill(pid,0)` должен дать ESRCH для продолжения; живой PID, EPERM и прочие результаты запрещают захват.
   3. Повторно прочитать lock и сверить ownerId; при изменении — LOCK. Переименовать lock в stale UUID и sync parent; в finally закрыть/удалить recovery; перейти к следующей попытке. Исчерпание двух попыток — LOCK.
6. `syncTree`: рекурсивно sync всех обычных файлов и вложенных каталогов, затем корня. Symlink не открывать как файл. `syncDirectory` должен open(path,'r'), sync, finally close.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| STORAGE | rejected Promise | Ошибка fs/JSON или runtime path/directory/file | Ресурс недоступен, небезопасен или несовместим |
| LOCK | rejected Promise | ownership lock… | Владение не подтверждено, recovery занят или lock повреждён |
