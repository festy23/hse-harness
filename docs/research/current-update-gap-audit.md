# Аудит текущего механизма обновлений HSE HARNESS

Дата: 18 октября 2026. Код: `a60e37a` (0.3.0); сравнение с `3ade71e` (рабочая база 0.2.3). Аудит read-only для production/test code; тесты в рамках этого исследования не запускались. Ни npm, ни VPS не менялись.

## Вывод

Почти весь путь «уведомление → кнопка → проверенный пакет → безопасное переключение → результат» уже существует. Ограничение относится к обновлению самого управляющего runtime, а не к Telegram. Самый небольшой разумный следующий шаг для Linux VPS — стабильный минимальный bootstrap с независимым наблюдением запуска engine, выбор engine по атомарному журналу и штатный выход supervisor после drain с перезапуском через systemd. Отдельный постоянно работающий updater, Docker, Kubernetes и новый CI/CD для этого не требуются.

Это рекомендация по устройству реализации, а не утверждение, что механизм уже готов. Один обслуживаемый переход нужен, чтобы установить новый bootstrap и обновить systemd unit на машинах с прежним launcher.

## Что уже реализовано — факты по коду

| Возможность | Факт и источник |
| --- | --- |
| Проверка npm latest | Каждые 60 минут; после ошибки повтор примерно через минуту. Допускается stable semver, официальный registry, sha512 SRI. [releases.ts:10](../../src/updates/releases.ts#L10), [telegram.ts:102](../../src/updates/telegram.ts#L102). |
| Ежедневное предложение | Не чаще раза за 24 часа с момента предыдущего предложения, а не фиксированное время суток. Кнопка «Обновить»; недоставленное предложение сохранено и повторяется. [telegram.ts:25](../../src/updates/telegram.ts#L25), [telegram.ts:30](../../src/updates/telegram.ts#L30). |
| Ручная проверка | `/updates` проверяет npm вне ограничения ежедневного предложения. Доступно только managed runtime постоянной глобальной npm-установки. [telegram.ts:41](../../src/updates/telegram.ts#L41), [runtime.ts:15](../../src/updates/runtime.ts#L15). |
| Авторизация | Callback допустим только от owner в его приватном чате; случайный offer ID, повторная проверка актуальных version+integrity, защита от устаревшей кнопки. Модель не вызывает установщик. [bot.ts:69](../../src/bot.ts#L69), [telegram.ts:55](../../src/updates/telegram.ts#L55). |
| Сохранённый запрос | Фазы authorizing/pending/installing/awaiting-apply/completed/failed и workerId. После смены worker незавершённая установка не предполагается успешной. Одноразовое разрешение восстанавливает прежнюю настройку updates. [telegram.ts:69](../../src/updates/telegram.ts#L69), [npm-update.mjs:10](../../runtime/npm-update.mjs#L10). |
| Проверка пакета | Exact version, SRI архива, безопасные tar paths, лимиты, manifest, inventory/dependency hashes, проверенная платформа esbuild и Pi import. Установка в staging, fsync, COMPLETE, атомарная публикация immutable release. [releases.mjs:157](../../runtime/releases.mjs#L157). |
| Изоляция | npm получает очищенное окружение и пустые npmrc; обычные install scripts отключены. Набор проверенного esbuild bootstrap задан явно. [releases.mjs:146](../../runtime/releases.mjs#L146), [npm-update.mjs:44](../../runtime/npm-update.mjs#L44). |
| Безопасное переключение worker | Один writer; drain/quiescent → finish → наблюдаемый exit → новый worker. При drain timeout продолжает прежний worker, а не SIGKILL. [supervisor.mjs:219](../../runtime/supervisor.mjs#L219), [supervisor.mjs:270](../../runtime/supervisor.mjs#L270). |
| Проверка после запуска | Probation 120 секунд, heartbeat и реальные exit/fatal; предыдущий выпуск и quarantine, ограниченные повторные старты. Падение сети/LLM не доказывает плохой пакет. [supervisor.mjs:49](../../runtime/supervisor.mjs#L49), [supervisor.mjs:311](../../runtime/supervisor.mjs#L311). |
| Результат в Telegram | Persistent runtime notices; только worker отправляет, supervisor не становится вторым sender. Успех объявляется после commit, не сразу после скачивания. [supervisor.mjs:98](../../runtime/supervisor.mjs#L98), [supervisor.mjs:347](../../runtime/supervisor.mjs#L347). |

Важное уточнение: настройка `updatesEnabled` означает автоматическое **применение уже установленной npm-версии**, а не скачивание каждого нового latest без согласия. Telegram устанавливает пакет после owner callback; supervisor отдельно наблюдает версию в глобальной установке. [npm-update.mjs:51](../../runtime/npm-update.mjs#L51), [supervisor.mjs:501](../../runtime/supervisor.mjs#L501).

`snapshot()` в UpdateRuntime — снимок диагностических полей, не backup учебного состояния. Immutable releases — снимки кода. Откат worker использует актуальные данные, а не откатывает память и очередь к прошлому дню. Это защищает уже принятые сообщения и внешние эффекты, но требует совместимых форматов. [runtime.ts:15](../../src/updates/runtime.ts#L15), [supervisor.mjs:28](../../runtime/supervisor.mjs#L28), [спецификация:210](../../docs/automatic-updates-spec.md#L210).

## Почему именно 0.2.3 → 0.3.0 требует другого пути — проверенные причины

1. В 0.2.3 `runtime/manifest.mjs` имеет `SUPERVISOR_VERSION = '1.0.0'`. Его `assertManifest` требует **строгого равенства** `manifest.minSupervisorVersion === SUPERVISOR_VERSION`. В 0.3.0 minimum — 1.0.1. Поэтому старый ReleaseStore отклоняет новый manifest ещё при подготовке пакета, до глобальной npm-установки. [исходник 0.2.3:86](https://github.com/festy23/hse-harness/blob/3ade71e/runtime/manifest.mjs#L86).
2. Есть дополнительные независимые проверки: `compatible()` не разрешает minimum выше версии текущего supervisor, а Telegram installer сравнивает minimum с `journal.supervisorVersion`. Простое удаление одной проверки не создаёт безопасного engine upgrade. [старый compatible](https://github.com/festy23/hse-harness/blob/3ade71e/runtime/supervisor.mjs#L28), [installer:32](../../runtime/npm-update.mjs#L32).
3. systemd запускает `HSE_HARNESS_HOME/runtime/launcher.mjs`, расположенный вне npm-prefix. Launcher — генерируемый JS со **статическим import конкретного engine по версии и hash**. npm install не переписывает этот файл и уже импортированный код процесса. Обычный systemd restart загрузит тот же старый engine, пока launcher не переустановлен. [installation.mjs:46](../../runtime/installation.mjs#L46), [installation.mjs:64](../../runtime/installation.mjs#L64).
4. `installRuntime()` отказывается менять runtime при живом supervisor.lock или service.lock. Это установщик остановленного runtime, не метод online handoff. [installation.mjs:30](../../runtime/installation.mjs#L30).
5. В старой установке engine копировался из выбранного `active` worker даже при новом установленном npm-пакете. В 0.3.0 исправлено: source engine берётся из отдельно проверенного **установленного выпуска**, выбранные active/previous/attempt сохраняются. Поэтому корректна инструкция новой версии `stop → npm install → service install`, а не вызов старого installRuntime до обновления CLI. [старый installer:38](https://github.com/festy23/hse-harness/blob/3ade71e/runtime/installation.mjs#L38), [новый installer:38](../../runtime/installation.mjs#L38), [regression test:83](../../test/runtime-installation.test.mjs#L83).
6. Текущий main unit имеет `Restart=on-failure`, `KillMode=control-group`, `TimeoutStopSec=90`. `requestStop()` посылает worker SIGTERM; это не update-specific drain/finish. Запускать обычный restart во время принятого Pi turn значит потерять гарантию «не прерывать запрос ради обновления». [system-service.ts:38](../../src/cli/system-service.ts#L38), [supervisor.mjs:535](../../runtime/supervisor.mjs#L535).

Manifest validation в 0.3.0 теперь допускает корректный minimum <=1.0.1, поэтому старые совместимые worker остаются читаемыми. Это **не** механизм установки будущего supervisor 1.0.2. [manifest.mjs:22](../../runtime/manifest.mjs#L22).

## Наименьшее разумное расширение — рекомендация

### Основной путь без отдельного updater-демона

Сохранить нынешние worker-only обновления. Добавить второй путь только для проверенного пакета, которому нужен новый engine:

1. На одобрение сохранять точные version+integrity+request ID. Использовать текущие hourly check/daily notice, `/updates`, приватный owner callback и outbox.
2. Подготовить immutable target release и immutable engine заранее, пока старый бот работает. Разделить проверки «архив/идентичность/среда/данные» и «может ли текущий engine запустить worker». Сейчас старый `assertManifest` останавливается раньше — его нельзя просто вызвать и ожидать поддержки будущего minimum.
3. Ввести небольшой постоянный bootstrap: проверка локальных engine descriptors, выбор engine по атомарному журналу, запуск engine отдельным child process, ограниченный startup handshake, relay сигналов и наблюдение фактического exit. Bootstrap остаётся родителем engine, но не управляет учебными workers/данными и не выполняет npm install, Telegram или Pi. Самостоятельный import engine в том же event loop не обеспечивает независимого startup timeout.
4. В отдельном небольшом engine handoff journal хранить active/previous/candidate, release integrity, engine hash, from/to, phase и лимит trial starts. Сохранить существующий runtime worker journal, не допускать двух конкурентных writers. Установщик bootstrap не должен безусловно продвигать worker или терять quarantine/manual hold.
5. Текущий supervisor выполняет уже существующий update drain. При busy — resume и отложить; ни restart, ни SIGTERM. Только после quiescent, finish и подтверждённого exit worker: сохранить handoff ready и долговечно опубликовать новый pointer, дождаться cleanup подготовки, освободить lock, выйти с выделенным restart code.
6. systemd делает новый запуск того же стабильного bootstrap. Специальный exit code можно объявить через `SuccessExitStatus=` + `RestartForceExitStatus=` при сохранении `Restart=on-failure`. Это выражает ожидаемый restart, а не маскирует обновление под аварийный exit. Официальная документация допускает такую комбинацию для main process и запрещает auto-restart после явного `systemctl stop`. [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#RestartForceExitStatus=).
7. Bootstrap **до запуска candidate** долговечно помечает trial start. Import/syntax failure или exit нового engine не должен навсегда ломать фиксированный launcher; на следующем запуске выбрать previous по trial journal. Независимый startup timer в bootstrap покрывает также зависший engine, который не выходит и не может исполнить свой таймер. Handshake должен подтвердить собственную готовность engine и владение supervisor lock до разрешения учебной активации. Прекратить заведомо pre-activation candidate и выбрать previous можно только после подтверждённого завершения всех принадлежащих ему процессов; если учебная активация уже могла произойти, timeout сам по себе не даёт права убить writer или запустить replacement. В этом случае нужны существующие drain/exit гарантии либо явный blocked. Успех engine upgrade фиксировать после проверки работающего compatible worker/непрерывного probation, а не после существования PID или сообщения systemd «active».
8. После восстановления рабочего worker продолжить уведомление из outbox. При провале вернуть previous **engine и совместимую выбранную пару worker**; нельзя запускать старый engine поверх worker/state, которые он не поддерживает. Сохранить quarantine identity и ограничение попыток.

Вариант «import engine в bootstrap + trial journal» покрывает crash/import error и восстановление на следующем запуске, но **не зависший startup без exit**. Для надёжного recovery необходим независимый observer: рекомендуемый здесь небольшой bootstrap parent с ограниченным startup trial и signal relay, либо отдельно настроенный systemd notify/startup timeout. Для systemd-варианта startup ограничивается `Type=notify`/`TimeoutStartSec` до `READY=1`; один `WatchdogSec` недостаточен, поскольку активируется после завершения startup. Эти механизмы требуют явного контракта готовности и определения безопасной границы до учебной активации; наличие systemd само по себе такой проверки не создаёт. [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#WatchdogSec=). При parent-варианте systemd управляет внешним сервисом, bootstrap — только запуском/выбором engine и его startup recovery, существующий supervisor — единственный владелец lifecycle workers и учебного состояния. Это не отдельный updater daemon и не дублирование автомата обновления workers.

Схема использует один main unit и не требует права произвольного sudo у бота. Самообновление **bootstrap** остаётся редким обслуживаемым изменением; обещание обновлять вообще любой будущий Node/OS/data migration одной кнопкой было бы неверным. Контракт bootstrap должен быть малым и версионированным, как текущий IPC.

### Почему недостаточно вызвать service install/restart из callback

`installRuntime` требует отсутствия живого процесса и сам пишет runtime journal/launcher. Callback находится внутри этого процесса, входит в lifecycle и не может одновременно ждать самого себя и безопасно переустановить runtime. Обычный дочерний shell тоже находится в том же cgroup: при stop systemd завершает оставшихся участников группы. Отключать KillMode ради выживания такого shell нельзя считать корректным решением. [локальный unit:40](../../src/cli/system-service.ts#L40), [systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html#KillMode=).

Альтернатива — отдельный одноразовый systemd updater unit, установленный заранее и запускаемый только узким запросом. Он может пережить остановку main unit и выполнить проверенную транзакцию/rollback. Это приемлемый запасной вариант, особенно если нужно менять unit files, но он добавляет права запуска, второй lifecycle и свой recovery. Для одной замены engine через фиксированный bootstrap это больше механизмов, чем нужно. Постоянный updater daemon и открытый HTTP endpoint не нужны.

## Что важно не обещать

- systemd `Type=simple` active означает процесс запущен; не доказывает локальную готовность приложения или доступность источников. Проверку внутреннего boot/health надо сохранить отдельно. [systemd.service Type](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Type=).
- Сеть, quota LLM и отдельный недоступный календарь не должны блокировать commit исправного engine. Проверка должна подтверждать код, lock ownership, IPC и writer invariants; состояние источников показывать degraded.
- Engine/worker rollback — откат кода при совместимом текущем формате данных. Он не отменяет отправленные сообщения, календарные PUT и уже принятую память. Произвольные необратимые schema migrations требуют отдельного контракта; восстанавливать старый data snapshot автоматически нельзя.
- Обновление даст короткую паузу. Отсутствие второго writer и сохранённый offset важнее обещания «ноль downtime» для одного личного бота.
- Первый переход с установленного 0.2.3 не появится сам после публикации будущего пакета: старый runtime не знает нового handoff и отклоняет minimum 1.0.1. Один setup/bootstrap migration остаётся нужен; после него compatible engine updates доступны из Telegram.
- Пока foreground/macOS не имеют проверенного внешнего restart owner, новый путь следует честно ограничить managed Linux/systemd. Их обычный worker update продолжает работать.

## Существующие тестовые гарантии и оставшиеся сценарии

Тесты уже содержат реальные процессы/IPC, не только mocks:

- immutable worker, один writer, busy drain/resume, lost activation ACK, сохранение данных и bounded rollback: [update-supervisor.test.mjs:54](../../test/update-supervisor.test.mjs#L54), [lost ACK:580](../../test/update-supervisor.test.mjs#L580);
- stopped engine install, источник установленного engine, сохранение selected worker/holds и отказ без повреждения launcher: [runtime-installation.test.mjs:83](../../test/runtime-installation.test.mjs#L83);
- pinned global prefix, проверка перед npm mutation, очищенные credentials и retry quarantine: [telegram-update-runtime.test.mjs:20](../../test/telegram-update-runtime.test.mjs#L20);
- реальный systemd cgroup cleanup после stop и parent crash: [systemd-updates.test.mjs:27](../../test/systemd-updates.test.mjs#L27).

Отсутствует сквозной contract test «private Telegram approval → engine upgrade → systemd restart → commit/rollback → ответ». Минимальная новая матрица:

1. Нажатие дважды и replay callback не создают вторую handoff transaction.
2. Candidate engine требует новый minimum; архив проверяется до закрытия admission старого worker.
3. Pi turn дольше drain budget: old worker продолжает, systemd restart не запрошен.
4. Падение между каждой fsync/rename/trial-start границей восстанавливает однозначную пару engine+worker.
5. Синтаксическая ошибка candidate engine, exit и зависание до startup handshake обнаруживаются независимым observer; previous возвращается без restart loop и только после доказанного отсутствия прежнего writer. Отдельный сценарий — engine завис после возможной учебной активации: отсутствие handshake не разрешает SIGKILL/параллельный writer, результат остаётся blocked до безопасного завершения.
6. Новый engine запускает worker, тот меняет актуальные данные и падает: rollback сохраняет эти данные при совместимом формате.
7. Явный service stop в середине подготовки/drain/ready не оживляет бот сам; последующий ручной start восстанавливает journal корректно.
8. Systemd перезапускает по выделенному коду; boot marker соответствует реальному процессу, не старому heartbeat/PID.
9. Сбой отправки финального Telegram notice не откатывает уже committed release, а продолжает outbox delivery.
10. Неизвестные схемы, Node minimum и bootstrap minimum дают понятное «нужен обслуживаемый переход», без обхода проверок.

## Источники и пределы исследования

Первичные источники: указанный локальный исходный код/тесты, git blob рабочей 0.2.3 и официальные man pages systemd (актуальная документация на 18.10.2026). Конкретную версию systemd, unit/drop-ins, права npm-prefix и состояние установленного VPS здесь не проверял; перед реализацией/rollout их надо читать на VM. Использованные RestartForceExitStatus/SuccessExitStatus документированы начиная с systemd 215/189; новые RestartMode=direct/debug не нужны и не рекомендуются как обязательная зависимость.
