# Блокировки локального писателя

## Метод и ресурсы

processLock(dir, filename='service.lock') возвращает async release.
withConfigWriteLock(path, action) исполняет action под lock `<basename>.lock`.
saveTelegramChat(path, chat, ownerId) изменяет config под этой блокировкой.
Ресурсы: lock/recovery/stale файлы, PID OS, config JSON, [writeSecret](persistence.md).

## Алгоритм processLock

1. Создать dir recursive/0700. Сформировать JSON identity с process.pid,
   randomUUID nonce, optional HSE_WORKER_ID и ISO startedAt.
2. В пределах двух попыток открыть lock через wx/0600, записать identity,
   file.sync, закрыть handle. При успехе вернуть release; при ошибке кроме EEXIST
   закрыть открытый handle и завершить ошибкой.
3. При EEXIST создать `<lock>.recovery` через wx/0600. Если recovery уже есть,
   отказать с `Writer lock recovery interrupted or in progress; inspect ...`.
4. Прочитать lock. Разрешить legacy JSON number либо Number(object.pid),
   потребовать safe integer >0. JSON/неверный pid даёт `Неизвестный lock; требуется проверка владельцем`.
5. Выполнить process.kill(pid,0). Только ESRCH разрешает считать процесс мёртвым.
   Успех проверки даёт `Другой экземпляр сервиса уже работает`; EPERM и другие
   ошибки не разрешают захват.
6. Прочитать lock ещё раз; при несовпадении байтов отказать `Lock изменился при проверке`.
   Rename в `<lock>.stale-<UUID>`, unlink stale, закрыть и удалить recovery в finally.
7. Вернуться к попытке создания lock. После двух неудач отказать
   `Не удалось получить writer lock`.
8. release читает lock и удаляет только при полном совпадении с собственной
   identity. ENOENT игнорирует; прочие filesystem errors передаёт.

## Алгоритм withConfigWriteLock

1. Разрешить полный path, вычислить until=Date.now()+5000.
2. Пытаться получить processLock(dirname,path basename+'.lock'). Повторять
   через 25 ms только ENOENT либо сообщения busy/recovery/unknown lock/changed lock/
   failed writer lock. При now ≥ until или иной ошибке завершить отказом.
3. После захвата await action(), вернуть его результат, release вызвать в finally.

## Алгоритм saveTelegramChat

1. Под config lock прочитать config UTF-8 и parseRecord.
2. Потребовать raw.ownerId===ownerId. Иначе отказать с требованием перезапуска агента.
3. Потребовать chats array, каждый элемент object с string id/title.
4. Если chat с тем же id уже существует, вернуть существующий объект, не менять
   allowQuestions/title и не записывать файл.
5. Иначе добавить входной chat в конец массива и вызвать writeSecret(path,
   JSON.stringify(raw,null,2)+'\n'). Остальные config fields сохранить из raw.
6. Вернуть добавленный chat после записи.

## Результат в случае ошибки

Блокировка не выдаётся при неподтверждённой смерти владельца. Ошибка action/записи
передаётся вызывающему; release исполняется независимо от результата. Межпроцессная
координация относится к одному пути lock, а не глобально к Telegram token.

Источники: [store.ts](../../../../src/store.ts), [config-file.ts](../../../../src/config-file.ts).
