# Автоматический подхват npm update: отказы, восстановление и приемка

Дата исследования: 13 октября 2026. Исследование исходников и первичной документации; живой бот и реальные аккаунты не запускались. Ни один описанный ниже механизм пока не реализован. Это материал для итоговой спецификации, а не отчет о прошедших тестах.

## Рекомендуемый контракт

После первого включения нового режима пользователь обновляет глобальный пакет обычной командой `npm update -g @ivan-boss/hse-harness`. Уже работающий supervisor замечает полностью установленную совместимую сборку, готовит самостоятельную копию и переключает единственный worker на нее. Ручные stop/restart для последующих обновлений не нужны. Между workers есть короткая пауза; одновременных Telegram pollers и писателей учебного состояния быть не должно.

Первая миграция с 0.1.0 требует одноразового штатного перезапуска: запущенная версия не содержит supervisor и не умеет начать наблюдение за npm. `npm update` сам по себе не может поменять уже исполняющийся процесс. Обновление npm/Node.js, смена глобального prefix, перенос home, несовместимая миграция данных и обновление самого протокола supervisor — отдельные операции; обещать их как часть бесшовного режима нельзя.

На Linux supervisor — главный процесс systemd unit; на macOS — главный процесс локального `hse-harness start`. В первой версии режима не требуется macOS launchd/Windows. Текущий [system-service.ts](../../src/cli/system-service.ts) запускает глобальный `bin/hse-harness.mjs run`; эта точка входа должна перейти к supervisor. Запущенный supervisor и worker должны работать из immutable release вне заменяемой npm директории, иначе отложенный import может прочитать уже удаленный файл или другую версию зависимости.

Публикацию в npm выполняет разработчик. Supervisor не скачивает произвольные новые версии сам, не запускает npm от root и не записывает глобальную установку. Источник кандидата — один ранее зарегистрированный глобальный package root и имя `@ivan-boss/hse-harness`. Не нужно добавлять новую модель памяти агента: release metadata и switch journal — служебные сведения о запуске; учебная память остается штатной Pi-сессией.

## Что в нынешнем коде не позволяет просто послать SIGTERM

1. [main.ts:37](../../src/main.ts#L37) сразу вызывает `pi.session.abort()` и `telegram.close()` при SIGTERM/SIGINT. Это аварийно прерывает текущий модельный turn, а не дает ему закончить tool. Закрытие Telegram может одновременно сорвать уже одобренный групповой вопрос.
2. [main.ts:68–73](../../src/main.ts#L68) проверяет `stopped` лишь перед очередным getUpdates, но обрабатывает весь полученный batch без проверки внутри. Drain нельзя подтверждать до завершения или безопасного сохранения этого batch. `Store.enqueueOwner()` присваивает случайный id и сохраняет его отдельно от botOffset; crash между этими сохранениями может создать повторную запись владельца. При развитии crash recovery нужно связывать запись с update_id, а не считать имеющуюся схему exactly-once.
3. [main.ts:86–100](../../src/main.ts#L86) удаляет элемент очереди только после Pi и отправки финального ответа. Это защищает от потери необработанного элемента, но повтор всего turn после частичного внешнего действия может снова вызвать tool или send. Наличие элемента в очереди не доказывает, что внешних действий еще не было.
4. [main.ts:103–121](../../src/main.ts#L103) одновременно выполняет таймеры, recover подтверждений и чтение календаря. Gate обновления должен охватывать все эти циклы, не только модельный turn.
5. [Store.save](../../src/store.ts#L43) уже сериализует снимки через Promise chain, пишет временный файл, `sync()` и `rename()`. Нет публичного `flush()` для shutdown barrier; запись не синхронизирует directory после rename. Следует отличать atomic видимость при process crash от гарантии при выключении питания.
6. [processLock](../../src/store.ts#L80) содержит только PID. `kill(pid, 0)` проверяет существование PID, не идентичность конкретного worker; PID может быть повторно использован. `unlock()` удаляет pathname без проверки владельца. В новом режиме нельзя использовать этот файл как разрешение убить процесс или запустить второго писателя.
7. [PiAssistant](../../src/pi.ts#L81) следит за исходами важных tools и сохраняет сессию через SDK. В установленном SDK 1.0.2 `AgentSession.abort()` ждет idle; `SessionManager._persist()` использует синхронную запись/append, но отдельного обещания fsync для каждой записи не дает. Нельзя выдумывать отсутствующий `flush()` SDK. При штатном переключении нужно дождаться idle, закончить запись и отдельно закрыть требуемый durability barrier над файлом сессии, проверенный на закрепленной версии SDK.
8. [ServiceControl.start](../../src/cli/service.ts) сейчас запускает dist/main.js непосредственно. [scripts/process.mjs](../../scripts/process.mjs) пересылает первый сигнал Unix process group и ждет exit; это полезная проверенная базовая функция, но не протокол переключения двух releases.

Исходники закрепленного SDK для проверки: `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`, методы `abort()/waitForIdle()/dispose()`; `dist/core/session-manager.js`, `_persist()`. Их нужно перепроверять при изменении зависимости, а не полагаться на имена методов старой версии.

## Протокол, который нужен для корректной реализации

### Сначала кандидат, затем пауза

Supervisor хранит active/previous/pending release id и фазу переключения в атомарном journal. Release id включает version и digest; одного package.json.version недостаточно. Не заменять active на основании fs.watch или изменения mtime: это только сигнал повторить проверку, а не свидетельство завершенного npm install.

После сверки с основной спецификацией предпочтителен более надежный источник staging: глобальная npm installation служит только триггером обнаружения версии; runtime заново устанавливается **по точному имени и версии** из закрепленного официального registry в private staging с проверкой dist integrity. Supervisor не выбирает latest сам; он только подготавливает ту версию, которую пользователь уже установил через npm. Это дополнительное скачивание, но не копирование меняющейся npm директории. Сетевая ошибка на этой стадии сохраняет работающий V1 и откладывает обновление. Доверие остается обычным доверием к npm publisher; integrity не защищает от скомпрометированного аккаунта издателя.

Последовательность: обнаружить кандидат → получить проверенную exact-version установку в private staging → проверить полный файловый manifest/хеши, имя, engines и protocol/schema compatibility → независимый локальный preflight из staging → атомарно оформить immutable release → запросить drain текущего worker → дождаться завершения и освобождения права записи → запустить кандидат с новым generation id → подтвердить локальную готовность → зафиксировать active → разрешить обработку и побочные действия.

Manifest должен покрывать весь исполняемый runtime, включая bundled node_modules и platform binaries после install scripts. Издательский checksum исходного tgz и runtime checksum после установки — разные вещи. Статическая проверка чтения manifest должна выполняться до исполнения кода кандидата. Контрольная сумма помогает обнаружить неполную установку, но не является доказательством доверия к скомпрометированному npm publisher. Preflight до остановки старой версии не получает реальные секреты, live writable state или сетевые транспорты.

Не снимать immutable копию активного worker после начала npm замены: worker получает полный свой release при его первоначальном запуске. Тогда временно отсутствующая npm директория, ошибка postinstall, пропавшая зависимость и последующее обновление npm prefix не затрагивают выполняющийся runtime.

### Drain — отдельное IPC действие

Сообщение `drain(requestId, candidateReleaseId)` закрывает admission всех новых jobs, model turns, polls, callbacks, timers и внешних действий; уже начавшаяся единица работы заканчивается. Паузы и retry sleeps становятся отменяемыми. Idle не означает пустую очередь: элементы, которые еще не взяты в работу, остаются на диске для следующего worker.

ACK `drained` отправляется лишь после окончания всех зарегистрированных in-flight операций, settle текущего Pi turn/compaction, завершения календарной transaction tail, записи операций/cursors/delivered/approvals и сессии, закрытия сетевых соединений. Далее worker освобождает принадлежащий ему lock и выходит; supervisor обязан дождаться подтвержденного exit, а не только ACK, прежде чем разрешать новому worker доступ к live state. Очередь источников и последняя авторизация не копируются между releases: оба последовательно используют одну home.

При drain timeout для обновления старый worker не следует автоматически SIGKILL: отменить переключение и вернуть admission, если worker еще функционирует. Кандидат остается pending; статус объясняет занятость или зависший сетевой запрос. SIGTERM/SIGINT пользователя и systemd stop — отдельный bounded shutdown сценарий; после deadline допустим SIGKILL только точно принадлежащему supervisor worker/process group. Это аварийный исход с recovery, не successful update.

Отмена должна быть возможна до необратимого dispose/disconnect/exit. Для этого нужна отдельная quiescing фаза: gate закрыт, in-flight work заканчивается, но transport еще не разрушен; после успешного барьера supervisor подтверждает terminal shutdown. При timeout/CANCEL worker снимает gate. Если старый worker уже ушел, CANCEL не может «вернуть» этот процесс: recovery запускает previous заново только после подтвержденного отсутствия старого writer.

Пример стартовых параметров для спецификации: detection interval 10 с, drain soft timeout 120 с, локальный startup timeout 30 с, probation 60 с. Это предлагаемые значения, которые нужно согласовать с измерениями и systemd `TimeoutStopSec`, а не факты о текущем проекте. Drain учитывает модели с длинным reasoning и compaction; при постоянной занятости обновление откладывается, статус остается видимым. Обычные исходящие таймауты должны быть bounded, а попытки повторной отправки не держат drain бесконечно.

### Readiness отделяется от внешних провайдеров

Локальная готовность: modules загрузились, протокол совпал, config/state/Pi session прочитаны без несовместимости, worker получил эксклюзивное право записи, циклы зарегистрированы и supervisor получает heartbeat. Это не означает успешный запрос к LLM или Telegram.

Неподдерживаемый Node, SyntaxError, MODULE_NOT_FOUND, неизвестная state schema и crash до handshake — дефект/несовместимость кандидата, допустим rollback. Исчерпан лимит модели, 429/5xx, DNS failure, отключенный интернет, просроченная подписка и временный IMAP/CalDAV timeout — `degraded`, а не автоматическая причина отката. Иначе публикация во время outages вызывает бесконечное переключение старой и новой версий. Текущий [initialize](../../src/main.ts#L124) ставит ready только после сетевого календаря/Telegram/Pi и отправки стартового сообщения; его ready нельзя напрямую переиспользовать как release readiness.

Preflight не запускает Telegram polling вторым экземпляром. После old exit candidate проходит локальный handshake до разрешения внешних действий; необратимая миграция данных не разрешается на этом этапе автоматически.

### Recovery и rollback

Journal и lock имеют разные роли: journal хранит желаемую фазу и releases, lock подтверждает единственного владельца запуска. Lock должен содержать random instance nonce, PID и generation/release id; разыменование и освобождение только с проверкой владения. Сам nonce в файле не решает гонку PID reuse. Надежная идентификация проверяет живой IPC peer и process start identity (platform adapter) либо использует kernel-backed эксклюзивный lock. Если identity не доказана, откажись убивать/перехватывать чужой PID, покажи оператору причину. Проверку heartbeat нельзя считать разрешением убить процесс: заблокированный event loop может удерживать реальные ресурсы.

При потере supervisor IPC worker прекращает admission, drains и выходит; новый supervisor не стартует второго writer, пока старый orphan жив и его полномочия не разрешены. При SIGKILL supervisor worker тоже может быть жив: systemd cgroup помогает на Linux, но протокол должен работать и в локальном запуске. State machine recovery выбирает единственный release из journal и реально завершенного процесса, не из mtime.

До разрешения побочных действий кандидат может упасть; предыдущая версия продолжает с тем же состоянием. После активации rollback использует **актуальное** состояние, а не snapshot до обновления: старый snapshot может забыть уже отправленный групповой вопрос, cursor, новую очередь или delivered marker. Rollback допустим лишь если предыдущий release понимает нынешние operations/config/Pi-session formats. В первой итерации разрешить только schema-compatible обновления; несовместимые блокировать до drain и оставлять старый runtime. Бэкап полезен для ручного восстановления, но не является безопасной автоматической компенсацией внешних эффектов.

Совместимость должна покрывать не только номер JSON schema, но и семантику receipt statuses, tool ids/payload, queue replay и формат новых записей Pi JSONL. Иначе older worker может прочитать валидный JSON, но повторить уже примененный новый tool. Preflight чтения не вызывает persistent SessionManager.open на live session и не обновляет live config/state; при необходимости используются закрытые копии и запрет записи.

Crash loop: например, три локальных аварии нового release за 60 с → исключить release id, один rollback на last-known-good, сохранить причину; повтор polling не активирует тот же digest снова. Сбой previous тоже не вызывает ping-pong: bounded backoff и operator-visible failed state. Очередь, secrets и учебная память никогда не удаляются. Тот же version+digest — no-op; одинаковая версия с другим runtime digest — подозрительная замена, отложить и сообщить; downgrade/prerelease автоматически не активировать. Отдельная явная rollback операция может выбрать проверенный previous.

## Ограничение гарантий доставки

Одобренный групповой вопрос использует сохраняемый `randomId`, состояние sending и recovery в [approvals.ts](../../src/approvals.ts); [telegram.ts:138](../../src/telegram.ts#L138) передает его в MTProto `messages.sendMessage`. Telegram документирует этот идентификатор для предотвращения повторной отправки: [messages.sendMessage](https://core.telegram.org/method/messages.sendMessage). При retry/перезапуске нужен тот же id и тот же payload, не новое одобрение.

Личные уведомления, финальные ответы и напоминания используют [bot.ts](../../src/bot.ts) `sendMessage`, после которого код записывает delivered. У Bot API в таблице параметров этого метода нет клиентского idempotency key: [sendMessage](https://core.telegram.org/bots/api#sendmessage). Следовательно, crash или timeout после принятой отправки, но до записи receipt имеет неоднозначный исход. Локальная очередь/журнал не делают HTTP отправку exactly-once.

Для штатного drain тест должен требовать отсутствие повторов: завершенная отправка и сохранение receipt входят в одну ожидаемую in-flight единицу. Для аварийного kill надо сохранять intent/payload до вызова, receipt/message_id после ответа, различать `pending/sending/sent/unknown`, и не заявлять одновременно гарантии «никаких потерь» и «никаких дублей». Для дедлайнов предпочтителен retry с явной возможностью повторного уведомления, чем молча считать unknown доставленным. При многочастном ответе нужны отдельные receipts на части; иначе повтор последнего chunk дублирует предыдущие. Такое усиление операционной доставки не должно превращаться в новую учебную память.

Bot updates на сервере сохраняются максимум 24 часа: [Getting updates](https://core.telegram.org/bots/api#getting-updates). Короткая штатная пауза допускает catch-up с прежнего offset; многосуточный outage нельзя описывать как гарантированное отсутствие потерь. Telegram channels и IMAP используют свои cursors/catch-up; это тоже нужно сохранить, а не сбрасывать при установке.

`SIGKILL` не исполняет обработчик JavaScript: [Node signal events](https://nodejs.org/api/process.html#signal-events). Любой тест «сохранил все при SIGKILL» должен опираться на записи, сделанные **до** kill, а не на shutdown finally. `FileHandle.sync()` — отдельный durability barrier; atomic rename нельзя подменять этим термином: [Node filesystem docs](https://nodejs.org/api/fs.html#filehandlesync).

## Приемочные сценарии

Все сценарии используют temporary npm prefix/home, собственные fixture процессы и loopback endpoints. Не считать терминальный вывод «новая версия найдена» доказательством переключения: измерять PID/release id, реальные tool effects, сохраненные файлы и счетчик одновременно активных pollers/writers. Управлять гонками через fixture barriers, а не случайный sleep.

| ID | Сценарий и точка сбоя | Обязательный результат |
| --- | --- | --- |
| U01 | V1 работает; реальный npm install/update ставит V2 в тот же global prefix | supervisor PID сохраняется; worker меняется один раз; V2 отвечает; нет ручного stop; данные/Pi history сохранены |
| U02 | npm directory переименована/частично пустая, manifest V2 уже виден, bundled dependency еще не установлена | V1 продолжает выполнять реальные tools из immutable V1; drain не начинается |
| U03 | exact-version archive/runtime совпал по version, но один файл поврежден, digest или dist integrity не совпадает | checksum/preflight отклоняет candidate; нет active promotion и остановки V1 |
| U04 | staging/preflight error: syntax, missing dependency, wrong name, engines, wrong IPC protocol | V1 жив; одна понятная ошибка; повтор polling не создает crash loop |
| U05 | повторное npm update без новой версии | worker PID не меняется; уведомления не дублируются |
| U06 | V2 и V3 ставятся подряд, V2 еще staging/drain/probation | последовательные поколения; stale ACK V2 не подтверждает V3; latest candidate определяется после безопасной точки |
| U07 | downgrade, prerelease, та же version с измененным digest | автоматическая активация отклонена; journal содержит причину |
| U08 | длинный LLM turn; barrier внутри update_task до и после calendar.putTask | обновление ждет полную transaction и save; один task, актуальный reminder; модель не abort из-за upgrade |
| U09 | accepted grouped SendMessage, ответ задержан до receipt save | drain ждет; нет раннего disconnect; один вопрос с исходным randomId |
| U10 | callback во время drain/getUpdates batch | он либо закончен и offset сохранен, либо остается неподтвержденным в серверной очереди; одобрение не теряется и не исполняется дважды |
| U11 | новые owner/source сообщения и mail UID появляются во время паузы | V2 догоняет с прежних offsets/UID/pts; ни source, ни owner message не теряется; owner priority сохранен |
| U12 | reminder due и morning/evening digest совпадают с переключением | после штатного switch одно актуальное уведомление/сводка; done/submitted semantics прежние |
| U13 | Pi compaction идет во время drain | дождались settle; сессия читается V2, search_history находит старые записи; не создана новая пустая память |
| U14 | drain timeout с functioning V1 | upgrade deferred; V1 возвращает admission; никаких принудительных kill; pending и причина доступны в status |
| U15 | LLM 429/лимит, DNS failure, Telegram/IMAP/CalDAV outage при старте V2 | локальный ready достигается; health degraded; queue сохранена, известные reminders продолжают работать; нет rollback по provider outage |
| U16 | candidate падает до local-ready/activation | один rollback V1; candidate не отправил побочных действий; входящая очередь сохранена |
| U17 | candidate активен, создал task/question/message, затем падает в probation | rollback только на compatible state; новые cursor/delivered/randomId сохранены; прежний snapshot не восстановлен |
| U18 | candidate несовместим с schema operations/config/Pi session | отклоняется до drain; V1 жив; нет auto migration или молчаливого empty state |
| U19 | три локальных crashes V2, затем repeated discovery V2 | один rollback, V2 quarantine по digest; нет ping-pong и повторной попытки каждые 10 с |
| U20 | SIGKILL supervisor в каждой фазе journal | после restart строго один worker; orphan lifecycle определен; сохраненные phases не приводят к одновременно V1/V2 |
| U21 | reboot/process crash после journal fsync, до rename / после rename, до ACK / после old exit | восстановлен непротиворечивый active или previous; никакое отсутствие ACK не трактуется как факт старого exit |
| U22 | stale service.lock с PID живого постороннего fixture процесса | тот процесс не получает сигнал и lock не удален без доказательства; status объясняет конфликт |
| U23 | два supervisor одновременно для одной home; delayed unlock старого поколения | только один получает ownership; старый unlock не удаляет новый lock; внешние эффекты выполняет один worker |
| U24 | systemd stop/CLI Ctrl+C во время staging/drain/probation | stop отменяет upgrade, не запускает replacement после stop; все собственные descendants завершены; state сохранено насколько исход допускает |
| U25 | SIGKILL worker после Bot API принял send, до receipt save | unknown delivery видима; выбранная retry policy соблюдена; тест не требует невозможного exactly-once |
| U26 | SIGKILL worker после MTProto принял question, до state sent | recover использует тот же randomId; одна серверная отправка; нет нового вопроса без нового approval |
| U27 | EACCES/ENOSPC/read-only FS при copy, manifest, journal save, Store save | до drain V1 продолжает; после drain состояние failed/recovery без второго writer; никакого active commit без durable journal |
| U28 | поврежден journal, missing active release, пропал previous, нет читабельного state | fail closed без сброса учебных данных; понятный diagnostic; никогда не запускается arbitrary mutable npm path |
| U29 | GC запускается при staging/recovery и updater без удаления предыдущего работающего runtime | active/previous/in-flight releases сохраняются; temp удаляется только своего поколения; место учитывает installed bytes |
| U30 | пользователь меняет model/config/secrets во время staging, OAuth refresh идет во время drain | worker читает актуальный единый home; свежие tokens не заменяются копией; несовместимая config вызывает controlled error |
| U31 | пакет postinstall не выполнялся (`--ignore-scripts`), dependency setup/native binary несовместим | проверки не принимают готовность по одному version; локальная ошибка отклоняет до остановки V1 |
| U32 | supervisor IPC устаревший/поддельный ACK с другим generation/request/release | ACK проигнорирован; active не продвигается; чужой process не получает live credentials |
| U33 | установка обновления от root; worker непривилегированный, home чужого владельца или небезопасный symlink | runtime discovery может читать установку; записи только своим uid/home; нет root worker и произвольной записи вне release root |
| U34 | первая миграция 0.1.0 → supervisor release | документированный одноразовый restart; последующий V2 → V3 проверяется U01; не заявляется бесшовность старого процесса |

Нужны отдельные property/invariant tests: число live writable workers ≤ 1; active всегда указывает на проверенный immutable release; незавершенный queue id не исчезает; receipt сохраняется до drain ACK; generation монотонна; release в quarantine не активируется автоматическим discovery; journal update атомарен и не пересекает чужое владение.

## Куда встроить проверки в проекте

- [test/package.test.mjs](../../test/package.test.mjs) уже устанавливает настоящий архив в isolated prefix и проверяет installed SDK/CLI/compiled daemon. Расширить двухархивным тестом V1/V2 через локальный fixture npm registry: настоящая команда **npm update**, а не только ручная перезапись version. npm 11 и 12, bundled dependencies, native bins, installed binary, explicit HSE home. V1/V2 имеют разные release markers, но одинаковую поддерживаемую schema. Сценарии установки из tgz полезны отдельно, но не заменяют update из registry.
- [test/e2e/run.mjs](../../test/e2e/run.mjs) уже имеет scripted Pi tools, fake clock, CalDAV, Telegram, IMAP и restart/crash. Добавить supervisor entry seam в test-only окружении и pause barriers в fixture transports. Проверять полноценную цепочку supervisor → immutable worker → настоящие domain tools → loopback effects; не подменять drain/switch test hooks.
- [test/e2e/preload.mjs](../../test/e2e/preload.mjs) использует Pi экземпляры целевого installed package. Для двух releases preload должен быть внутри каждого собственного runtime либо разрешать SDK относительно worker, иначе тест заменит одну копию SDK, а другая обратиться к реальному провайдеру. Без allowlist localhost сетевые вызовы теста должны аварийно запрещаться.
- [test/cli-service-signal.test.ts](../../test/cli-service-signal.test.ts) и [test/cli/service_checks.py](../../test/cli/service_checks.py) — база проверки SIGINT/SIGTERM descendants. Новая проверка обязана различать update drain, operator stop и supervisor kill; существующие тесты group signal forwarding сохранить.
- [test/core.test.ts](../../test/core.test.ts) уже проверяет reminder replay и approval random_id. Добавить deterministic send/save crash boundaries, immutable pending payload и unknown receipt. Это проверки операционной корректности, не тесты переписанного алгоритма memory.
- [test/installation.test.ts](../../test/installation.test.ts) — домашние permissions, symlink rejection, import и systemd escaping. Расширить ownership locks, releases GC, journal atomic replacement, disk/full permission errors. Не читать настоящие `~/.hse-harness` и service.lock пользователя.
- [.github/workflows/ci.yml](../../.github/workflows/ci.yml) сейчас Linux Ubuntu 24.04/Node24/npm12 и `systemd-analyze verify`. Это проверка syntax unit, не работающего systemd. Нужен отдельный isolated VM/container job с настоящим systemd PID1, SIGKILL/restart/cgroup assertions; macOS matrix для foreground supervisor/PTy, npm11/12. Node baseline22.19 и Node24; не тестировать только текущий Node26 разработчика. Если CI systemd недоступен, явно помечать этот acceptance gate как не выполненный.

Счетчики одновременных Telegram getUpdates, active session writers и эффекты calendar/group/owner должны сохраняться fixture сервером вне workers. Crash тесты убивают только процесс/группу, созданную тестом. Real npm update не должен обращаться к пользовательскому registry токену: отдельный npmrc/cache и temporary fixture registry.

## Наблюдаемость и эксплуатационные условия

`hse-harness status` должен независимо показывать installed version, supervisor version/protocol, running worker version/digest, pending version и phase, последнюю причину deferred/rollback, worker generation и degraded provider health. `--version` показывает установленный CLI, а не гарантирует runtime version. Спам startup/rollback сообщениями подавлять persistent notice key; секреты/тексты чатов/токены не входят в journal и логи.

Пути release/home принадлежат service uid и имеют закрытые permissions; runtime никогда не пишет в npm directory. Учитывать размеры **распакованных** bundled releases, минимум active+previous+staging и дисковый запас. Нельзя удалить предыдущую рабочую сборку для освобождения места до проверенной активации новой. Root/npm prefix, shared host users и sudo окружение требуют явного path/uid контракта: home выбирается по настройке сервиса, не по effective HOME обновляющего root.

Дальнейшая реализация считается готовой лишь после двухarchive npm-update интеграции, drained side-effect сценариев, rollback без state rewind и crash ownership сценариев. Простой watcher + SIGTERM + launch latest этого контракта не выполняет.
