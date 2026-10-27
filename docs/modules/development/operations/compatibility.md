# Совместимость развёрнутых версий

## Назначение и границы

Фиксировать поведение [deploy](../../../../deploy/) ревизии `f3bacd3`: три импортируемых compatibility adapter и статический systemd unit. Адаптеры изменяют прототипы классов в текущем Node.js процессе; отдельного сетевого сервиса или постоянной БД не создавать. Импорт модуля исполняет автоматическую установку только при точном совпадении gates ниже. Экспортированные install-функции вызываются напрямую независимо от env и версии; самостоятельно gates внутри них не проверять.

Жизненный цикл актуальной управляемой установки определяется [Runtime](../../runtime/README.md), настройка и управление службой — [CLI](../../cli/README.md). Обычные интеграции текущего приложения определяются [Sources](../../sources/README.md) и [Calendar](../../calendar/README.md); compatibility adapters не должны подменять описание их текущего поведения.

## Ресурсы и настройки

| Настройка | Тип | Обязательность | Значение по умолчанию | Правило |
|---|---|---|---|---|
| HSE_RELEASE_VERSION | env string | Для автоматической установки | Нет | Строгое строковое сравнение; semver ranges не использовать |
| HSE_ICLOUD_COLLECTION_COMPAT | env string | Для CalDAV gate | Нет | Только `1` вместе с release `0.2.0` |
| HSE_ICLOUD_COMPAT_MODULE | URL string | Нет | URL `./calendar/providers/caldav.js` относительно file URL resolve(process.argv[1]) | Разрешить только file: |
| HSE_TELEGRAM_PROXY_FILE | path string | Для Telegram gate | Нет | Truthy строка вместе с release `0.2.1` |
| HSE_IMAP_ERROR_COMPAT | env string | Для IMAP gate | Нет | Только `1` вместе с release `0.2.3` |
| TELEGRAM_API_ID | secret string → Number | Для созданного Telegram клиента | Нет | Получать из импортированного dist/config.js |
| TELEGRAM_API_HASH | secret string | Для созданного Telegram клиента | Нет | Получать из импортированного dist/config.js |
| process.argv[1] | entry path | При сработавшем gate | Нет | Преобразовывать resolve; root для Telegram/IMAP — dirname(dirname(entry)) |

Все импортируемые локальные файлы, внешние SDK и proxy JSON читать только после успешного gate. Несовпадение gate завершает import без этих действий. Установленные замены живут до завершения процесса или следующего присваивания соответствующего prototype/global поля; снятия замены и персистентного реестра установок нет.

## CalDAV collection adapter

### Метод

`installCalDAVCollectionCompatibility(Collection) → void`, источник [icloud-compat.mjs](../../../../deploy/icloud-compat.mjs).

### Алгоритм работы

1. При автоматической установке потребовать HSE_ICLOUD_COLLECTION_COMPAT=`1` и HSE_RELEASE_VERSION=`0.2.0`. Вычислить moduleURL по таблице; разобрать new URL и потребовать protocol=file:, иначе Error `CalDAV compatibility requires a local adapter`. Импортировать moduleURL, взять CalDAVCollection и вызвать install.
2. install требует `typeof Collection?.prototype?.objects === 'function'`; иначе Error `Unsupported CalDAV adapter for 0.2.0 compatibility`. Присвоить новый метод objects всему прототипу. Исходный метод не вызывать и не сохранять.
3. На каждом objects(urls) вычислить base=new URL(this.calendar.url), затем вернуть результат this.client.fetchCalendarObjects с полями таблицы.

   | Поле запроса SDK | Формирование |
   |---|---|
   | calendar | this.calendar без преобразования |
   | objectUrls | входной urls без преобразования, включая undefined |
   | urlFilter | Функция проверки каждого URL из следующего шага |
4. urlFilter(value) выполняет new URL(value,base). Вернуть true только при одновременном выполнении всех условий: origin равен base.origin; pathname.startsWith(base.pathname); pathname не равен base.pathname; pathname не заканчивается `/`; search/hash/username/password пусты. При исключении разбора вернуть false. Расширение `.ics` не требовать.
5. Результат/отклонение fetchCalendarObjects передать без изменения. Дополнительных запросов, retry, timeout и OperationContext adapter не добавляет; параметры транспорта определяет экземпляр this.client. Ошибка base URL происходит до запроса.

### Ошибки и безопасность

Фильтр ограничивает результат SDK URL текущим origin и строковым префиксом пути коллекции; отдельной нормализации границы сегмента сверх URL.parse и startsWith не делать. `objectUrls` самостоятельно не фильтровать: передавать вместе с urlFilter в SDK. Ошибка модуля/import или install завершает импорт адаптера неуспешно. После успешного install все экземпляры Collection используют заменённый метод.

## Telegram WSS adapter

### Метод

`installTelegramFactoryCompatibility(Source,createClient) → void`, источник [telegram-wss-compat.mjs](../../../../deploy/telegram-wss-compat.mjs).

### Алгоритм работы

1. При автоматической установке потребовать release=`0.2.1` и truthy HSE_TELEGRAM_PROXY_FILE. Вычислить entry=resolve(argv[1]), root=dirname(dirname(entry)).
2. Импортировать через file URL относительно root: dist/telegram.js (TelegramSource), dist/config.js (secret), node_modules/teleproto/index.js (TelegramClient), node_modules/teleproto/sessions/index.js (StringSession), node_modules/teleproto/extensions/PromisedWebSockets.js. Создать require от root/package.json и загрузить https-proxy-agent и ws.
3. Прочитать proxy file UTF-8 и JSON.parse. Сформировать new URL(`http://${config.host}:${config.httpPort}`); присвоить username=config.username и password=config.password. Дополнительную проверку типов/диапазона port/непустоты полей в этом legacy adapter не выполнять. Ошибки файла, JSON и URL пробрасывать.
4. Присвоить глобальный PromisedWebSockets.webSocketImpl классу-наследнику WebSocket. Каждый constructor(url,protocol) вызывает super(url,protocol,{agent:new HttpsProxyAgent(proxy),handshakeTimeout:10000}). Credentials использовать в агенте прокси; собственных диагностических логов адаптер не пишет.
5. Установить factory через installTelegramFactoryCompatibility. Factory(saved) создаёт TelegramClient по таблице, вызывает client.setLogLevel('none') и возвращает клиент без connect.

   | Поле конструктора | Формирование |
   |---|---|
   | session | new StringSession(saved) |
   | apiId | Number(secret('TELEGRAM_API_ID')) |
   | apiHash | secret('TELEGRAM_API_HASH') |
   | options.networkSocket | PromisedWebSockets |
   | options.connectionRetries,reconnectRetries | 3,3 |
   | options.timeout | 15 секунд |
6. install сохраняет original=Source.prototype.connect и заменяет его обычной функцией. При каждом connect(...args) сначала присваивать this.options={...this.options,createClient:this.options?.createClient??factory}; затем возвращать original.apply(this,args). Явный createClient сохранять; прочие options сохранять через spread. Дополнительной проверки класса/метода нет.

### Ошибки и конкурентность

Import, чтение конфигурации и создание фабрики выполняются без дополнительного timeout/retry адаптера. WSS handshake ограничен 10000 ms, MTProto SDK получает timeout/retries из таблицы; actual connect и его управление принадлежат исходному TelegramSource. Ошибки original.connect и фабрики передавать вызывающему. Изменение webSocketImpl является общим для всех использующих его клиентов процесса. Повторный install оборачивает текущий метод ещё раз; marker идемпотентной установки отсутствует.

## IMAP error adapter

### Метод

`installImapCompatibility(ImapFlow,guard) → void`, источник [imap-errors-compat.mjs](../../../../deploy/imap-errors-compat.mjs).

### Алгоритм работы

1. Для автоматической установки потребовать release=`0.2.3` и HSE_IMAP_ERROR_COMPAT=`1`. Вычислить root=dirname(dirname(resolve(argv[1]))). Импортировать ImapFlow из root/node_modules/imapflow/dist/esm/imap-flow.js. Импортировать guardImapClient из `./imap-session.mjs` относительно import.meta.url самого compatibility файла.
2. Сохранить исходные ImapFlow.prototype.connect и logout. Проверку наличия/типа этих методов не добавлять. Заменить оба метода async wrappers; замены действуют для всех экземпляров.
3. connect(...args) сначала вызывает guard(this). Затем в try await originalConnect.apply(this,args) и возвращает результат. При отказе вызвать this.close(), затем бросить исходную ошибку. Если close сам бросает, наружу выходит его ошибка; guard error происходит до try и не вызывает эту catch-ветвь.
4. logout(...args) в try возвращает await originalLogout.apply(this,args); finally всегда вызывает this.close(). Ошибка close может заменить результат/ошибку logout.
5. Отдельного deadline, retries, reconnect, состояния cursor или отправки сообщений adapter не добавляет. Подключение/закрытие делегировать SDK, guard — [Sources IMAP session](../../sources/operations/imap-session.md).

### Ресурс companion module

Путь `deploy/imap-session.mjs` не входит в исходники ревизии `f3bacd3`; автоматическая gate-ветвь требует companion module рядом с фактически загруженным compatibility файлом. При его отсутствии dynamic import завершается ошибкой до install; автоматически копировать или генерировать его adapter не должен. Прямой вызов export install принимает guard от вызывающего и этого файла не читает.

## Статическая systemd служба

Применять [study-assistant.service](../../../../deploy/study-assistant.service) как unit с фиксированными значениями таблицы. Unit не включает compatibility adapters через --import и не устанавливает их env gates.

| Секция/поле | Значение и действие |
|---|---|
| Unit.Description | HSE Personal Study Assistant |
| Unit.After, Wants | network-online.target; зависимость порядка и желание запуска target |
| Service.Type | simple |
| Service.User, Group | study,study |
| Service.WorkingDirectory | /opt/hse-study-assistant |
| Service.ExecStart | /usr/bin/env node dist/main.js |
| Service.Environment | NODE_ENV=production |
| Service.Restart | on-failure |
| Service.RestartSec | 10 секунд |
| Service.TimeoutStopSec | 50 секунд |
| Service.UMask | 0077 |
| Service.NoNewPrivileges | true |
| Service.PrivateTmp | true |
| Install.WantedBy | multi-user.target |

ExecStart запускает исходный worker напрямую, без runtime supervisor из актуального управляемого запуска. Node разрешается /usr/bin/env из окружения systemd; unit не фиксирует абсолютный путь Node. Ошибку старта/аварийный выход обслуживает Restart=on-failure с паузой 10 секунд; остановку ограничивает TimeoutStopSec. Установку пользователя study, каталога, секретов и enable unit сам файл не выполняет.
