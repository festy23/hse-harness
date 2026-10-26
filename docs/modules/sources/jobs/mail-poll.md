# IMAP poll slice

## Описание

Читать текст новых писем после последнего полностью обработанного UID каждой папки и сохранять Source до cursor.

## Запуск

[Core sourceLoop](../../core/jobs/worker.md) с именем Почта; MailSource.poll(parent?) создаёт отдельную source operation budget 120000 ms. Каждый poll создаёт новое IMAP соединение.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| config.folders | string[] | Да | Явные папки либо обнаружение при пустом массиве |
| parent | OperationContext | Нет | Родительская отмена/deadline |
| continuing | ()→boolean | Да | Допуск продолжения, default true |

## Результат

`{complete:true,initialComplete:true}` только после всех папок и проверки здоровья; частичная работа или собственный deadline возвращает false/false. Остальные ошибки отклоняют Promise.

## Ресурсы

[Настройки и secrets](../settings.md), [cursors](../database/README.md), imapflow, [IMAP guard](../operations/imap-session.md), [текст](../operations/mail-text.md), [Core enqueue](../../core/operations/ingestion.md).

## Алгоритм работы

1. Создать guardImapClient(new ImapFlow) с настройками imap.yandex.ru,993,secure=true,logger=false,connectionTimeout=20000,socketTimeout=30000 и auth={user:secret(YANDEX_ADDRESS),pass:secret(YANDEX_APP_PASSWORD)}. Зарегистрировать ctx.abort→client.close, проверить отмену, connect, assertImapHealthy.
2. Если config.folders непуст, использовать его порядок. Иначе await client.list(), исключить entries с specialUse в ['\Trash','\Junk','\Drafts'], выбрать path в порядке ответа.
3. Для каждой folder при !continuing вернуть false/false; иначе проверить отмену и получить getMailboxLock(folder,{readOnly:true,acquireTimeout:max(1,min(30000,ceil(ctx.remainingMs())))}) . Отсутствующий client.mailbox завершает Error `Папка не открыта`. validity=mailbox.uidValidity.toString().
4. Прочитать cursor mail:folder. При совпадении previous validity last=Number(previous uid), иначе last=0. Выполнить client.search({since:new Date('2026-08-31T00:00:00Z')},{uid:true}); не-массив трактовать как []. Оставить uid>last, отсортировать по возрастанию.
5. Разделить IDs на пачки до 25. Перед пачкой при !continuing вернуть false/false и проверить отмену. Вызвать client.fetchAll(ids,{uid:true,envelope:true,internalDate:true,bodyStructure:true},{uid:true}). Пройти messages в порядке ответа fetchAll; перед каждым проверять continuing и отмену; выполнить pollMessage ниже.
6. После всех пачек вернуть true из обработки папки. В finally всегда release mailbox lock. После всех папок проверить отмену и assertImapHealthy, вернуть true/true.
7. При любом исходе соединения запустить cleanup timer на 5000 ms (unref), который вызывает close. Если client.usable и ctx не aborted, ждать logout, подавив его ошибку. В finally очистить timer, close и удалить abort listener.
8. На внешней границе poll при aborted ctx: если parent не aborted и reason — OperationError deadline, вернуть false/false; иначе бросить ctx.reason. Неотменённые ошибки передать. В finally dispose ctx.

## Алгоритм pollMessage

1. Создать дочернюю request operation 45000 ms; зарегистрировать message.abort→client.close. Проверить отмену; при отсутствии m.internalDate бросить `IMAP не вернул дату письма`.
2. Если new Date(internalDate)>=HISTORY_FROM, выполнить [readText](../operations/mail-text.md), сформировать Source по таблице, проверить отмену и assertImapHealthy, дождаться Store.enqueue([source]). При более старом письме пропустить чтение тела и enqueue.

   | Поле Source | Правило |
   |---|---|
   | id | `mail:`+hash(envelope.messageId ?? `<folder>:<validity>:<uid>`) |
   | kind | mail |
   | text | `Тема: `+(envelope.subject??'')+'\n'+readText результат |
   | date | new Date(m.internalDate).toISOString() |
   | author | envelope?.from?.map(a=>a.address).join(', '), undefined при отсутствии from |
   | url | https://mail.yandex.ru/ |
3. Проверить отмену и assertImapHealthy, записать cursors[`mail:<folder>`]=`<validity>:<uid>` и save. Это выполняется также для писем старше HISTORY_FROM.
4. При aborted message выбросить signal.reason, иначе исходную ошибку. В finally удалить abort listener и dispose message scope.

## Неуспешное выполнение и доставка

Ошибка download, MIME, socket, compute или enqueue оставляет cursor текущего письма непродвинутым. Ошибка save cursor после enqueue допускает повтор ingestion с тем же source id. Ранее сохранённые письма не откатывать. Смена UIDVALIDITY вызывает сканирование с last=0; наличие envelope.messageId сохраняет стабильную дедупликацию между папками. Нет команды удаления/пометки писем; mailbox открывается readOnly. Порядок сообщений fetchAll дополнительно не сортируется; cursor записывается в порядке ответа.
