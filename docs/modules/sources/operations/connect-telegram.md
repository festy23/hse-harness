# Создание и подключение MTProto клиента

## Метод

createTelegramClient(saved), telegramDeadline(action,ms,cancel?), TelegramSource.connect(ctx?), close().

## Ресурсы

[Session](../database/README.md), [кэши](../caches.md), [настройки](../settings.md), [RPC](telegram-rpc.md), [dialogs](telegram-pages.md), teleproto.

## Входные и выходные параметры

saved — сериализованная session string; ctx — необязательный контекст; connect/close возвращают void; createTelegramClient возвращает ещё не подключённый TelegramClient. telegramDeadline возвращает результат action либо timeout Error.

## Алгоритм createTelegramClient

1. Выбрать proxy file из TELEGRAM_PROXY_CONFIG ?? HSE_TELEGRAM_PROXY_FILE, transport из TELEGRAM_TRANSPORT ?? (file?'wss':'tcp'). Для другого transport завершить ошибкой.
2. Для wss выбрать proxy из TELEGRAM_HTTP_PROXY ?? HTTPS_PROXY. Если задан file, прочитать JSON record; потребовать string host, username, password и integer httpPort 1..65535; иначе ошибка proxy config. Сформировать URL `http://<host>:<httpPort>`, задать username/password, заменить proxy.
3. Если proxy truthy, разобрать URL, разрешить только http:/https: без hash, иначе ошибка. Создать класс ws, который при каждом соединении передаёт HttpsProxyAgent(url), handshakeTimeout=15000; присвоить его глобальному PromisedWebSockets.webSocketImpl. При WSS без proxy значение webSocketImpl здесь не сбрасывать. Для tcp этот путь не исполнять.
4. Создать TelegramClient(new StringSession(saved),Number(secret(API_ID)),secret(API_HASH), options из settings), для wss добавить networkSocket=PromisedWebSockets. Выставить LogLevel.NONE и вернуть client.

## Алгоритм connect

1. Выполнить withOperation(connect,120000,ctx). Если опубликованный client существует и connected!==false, успешно завершить. Иначе если client._sender.isReconnecting, выполнить updates.GetState через RPC и завершить по его результату.
2. При отсутствии connecting проверить: если authFailure отсутствует и now<retryAt, завершить OperationError transport `Telegram: ожидаю следующую попытку подключения`. Иначе создать независимый scope connect/120000 и общую попытку.
3. В connectAttempt увеличить generation, убрать client; прежний client destroy (либо disconnect), ждать через telegramDeadline/5000 и подавить cleanup ошибку. Прочитать и trim session, проверить отмену. sessionHash=hash(session). Если authFailure.sessionHash совпадает, бросить сохранённую ошибку без нового клиента; иначе удалить authFailure.
4. Создать candidate; зарегистрировать отмену scope, запускающую однократный dispose кандидата. Запустить candidate.connect с таймером 45000 ms: таймер вызывает dispose, и если connect завершился после срабатывания, бросить OperationError deadline/request. Очистить таймер в finally, проверить отмену.
5. Выполнить updates.GetState, остановить candidate.updateManager, прочитать все dialogs. Для каждого config.chats найти entity по каноническому id; при отсутствии завершить permission `Нет доступа к выбранному чату <id>`. Собрать новую Map id→getInputPeer(entity). Проверить отмену и совпадение generation, иначе cancelled `Подключение Telegram заменено`. Только затем присвоить client=candidate и peers=новая Map.
6. При ошибке destroy/disconnect candidate, подавив cleanup ошибку. Для OperationError authentication записать authFailure={sessionHash,error}. Если scope aborted, вместо исходной ошибки вернуть reason. Убрать abort listener и candidate в finally.
7. Успех общей попытки обнуляет failures/retryAt. authentication ошибка обнуляет retryAt, не увеличивая backoff. Иная ошибка, кроме scope cancelled, задаёт retryAt=now+[1000,5000,15000,60000][min(failures++,3)]. finally выставляет settled=true, dispose scope и удаляет matching connecting.
8. Каждый вызывающий увеличивает waiters, ждёт гонку общего Promise и своего signal. После успеха проверяет собственную отмену. В finally удаляет listener, уменьшает waiters; если waiters=0 и попытка не settled, abort общего scope с waiter.reason либо cancelled и дождаться его завершения, подавив ошибку. Один отменённый waiter не прерывает остальных.

## Алгоритм close и deadline

1. close увеличивает generation; abort connecting с cancelled/stop `Telegram остановлен`; запускает cleanup candidate с подавлением ошибок.
2. Снимает client с экземпляра; опубликованный клиент destroy/disconnect ждёт через telegramDeadline 5000 с подавлением ошибок; затем ждёт connecting.promise с подавлением ошибки. peers/authFailure отдельно не очищаются.
3. telegramDeadline выполняет Promise.race(action,timer). При таймере вызывает cancel при наличии и отвергает Error `Telegram: подключение не завершилось вовремя; повторю попытку`. В finally очищает timer; исходный action без cancel сам по себе не отменяется.

## Ошибки

| Код | Message/условие | Результат |
|---|---|---|
| authentication | RPC 401 | Блокировать эту session до смены её hash |
| permission | Нет выбранного чата / RPC 403 | Не публиковать candidate |
| deadline/cancelled | Истёк scope, connect timer, replaced generation | Прекратить публикацию и закрыть candidate |
| transport | Backoff, сетевой сбой | Повторить только следующим connect после retryAt |
| config/filesystem | Неверный transport/proxy, session read, secret | Отклонить Promise |
