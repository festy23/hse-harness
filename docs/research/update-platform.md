# Платформа обновлений: npm, Node.js и systemd

Дата проверки: 13 октября 2026. Назначение: исследование для спецификации автоматического переключения HSE HARNESS после `npm update -g @ivan-boss/hse-harness`. Это проектные рекомендации, а не реализованный механизм.

## Проверенные факты

### npm не предоставляет атомарную замену работающего приложения

В исходниках установленного npm **12.2.0** проверена последовательность Arborist: перемещение прежнего дерева в retirement-каталог, создание нового дерева, распаковка, возврат неизменённых зависимостей, build/lifecycle, удаление старых файлов. При ошибках предусмотрены несколько этапов отката; последняя очистка уже не откатывается. Это транзакция установщика с промежуточными состояниями файловой системы, а не атомарное переключение исполняемого приложения. [Исходники reify.js, npm v12.2.0](https://github.com/npm/cli/blob/v12.2.0/workspaces/arborist/lib/arborist/reify.js).

**Вывод для проекта:** текущий `package.json` может отсутствовать, быть недописанным или уже показывать новую версию, пока установка ещё продолжается. Прежний процесс продолжает выполнять загруженный JavaScript, но отложенные импорты и чтение ресурсов по прежнему пути могут столкнуться с заменой дерева. Нельзя запускать production-worker или supervisor из изменяемого global npm-каталога и считать его защищённым от обновления.

В global mode npm ориентируется на `wanted`, который при отсутствии semver-диапазона равен dist-tag `latest`. Документация предупреждает и о downgrade версии, которая новее `latest`. [npm update, исходная документация v12.2.0](https://github.com/npm/cli/blob/v12.2.0/docs/lib/content/commands/npm-update.md).

**Вывод:** нельзя считать каждое изменение manifest повышением версии. В первой реализации автоматически принимать только совместимые повышения; downgrade и prerelease требуют явного выбора. Команда `npm update` без `-g` обновляет другое дерево и не является командой обновления глобальной установки бота.

### postinstall не является надёжным событием завершения

Проверены npm 12.2.0 `rebuild.js` и актуальная документация через Context7 `/npm/cli`: npm 12 ограничивает dependency lifecycle политикой `allowScripts`, а `--ignore-scripts` блокирует их независимо от разрешения. Bin links не зависят от этого разрешения. [Исходники rebuild.js](https://github.com/npm/cli/blob/v12.2.0/workspaces/arborist/lib/arborist/rebuild.js), [изменения npm 12](https://github.com/npm/cli/blob/v12.2.0/CHANGELOG.md).

**Вывод:** обновление нельзя основывать на нашем `postinstall`. Hook может вообще не выполниться; если выполнится, это ещё не означает успешный выход внешней команды npm. Hook допустим как дополнительный сигнал, но не как обязательная часть корректности. Запрашивать `sudo systemctl restart` из hook нельзя: установка может выполняться другим пользователем, без TTY, с запрещёнными scripts; разрешение устанавливать npm-пакет не означает наличие полномочий администрировать systemd.

Дополнительная проверка установленного **npm 11.17.0** выявила отличие: он уже поддерживает `--allow-scripts`, но unreviewed scripts ещё запускаются. В npm 12 unreviewed scripts блокируются. Поэтому одинаковое имя флага не означает одинаковую политику. [rebuild.js npm 11.17.0](https://github.com/npm/cli/blob/v11.17.0/workspaces/arborist/lib/arborist/rebuild.js).

В npm 12 bundled dependency в `script-allowed.js` получает `null` и не может быть разрешена обычной allowlist по имени/версии. Следовательно, `--allow-scripts=esbuild` **не гарантирует** выполнение bundled esbuild postinstall. [script-allowed.js npm 12.2.0](https://github.com/npm/cli/blob/v12.2.0/workspaces/arborist/lib/script-allowed.js).

Практичная единая политика staging для npm 11/12: `npm install --global --prefix <unique-stage> <verified-local-tgz> --omit=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/`, с аргументами массивом, очищенным окружением и отдельным timeout. Optional зависимости не отключать. После установки проверить реальное выполнение esbuild API, а не только `import('esbuild')`. Если требуется platform bootstrap, разрешён только **явный** запуск заранее проверенного `node <staged-package>/node_modules/esbuild/install.js` supervisorом, без shell и production-секретов; дождаться завершения и повторить smoke test. Это ограниченная часть staging, а не произвольное выполнение lifecycle всех dependencies. Для неизвестной версии bootstrap script policy требует пересмотра.

В фактическом bundled дереве текущего пакета install scripts найдены у `esbuild@0.28.2` (подготовка platform binary), `protobufjs@7.6.6` (предупреждение о версии зависимости), `@google/genai@2.21.0` (no-op). В прочитанном `esbuild@0.28.2/install.js` download fallback сверяет binary SHA-256 с `esbuild.binaryHashes` в manifest и проверяет версию executable. Staging должен проверять этот manifest/script в составе архивного inventory, убрать `ESBUILD_BINARY_PATH` и запрещать arbitrary override. Bootstrap может требовать сеть при отсутствии подходящего optional binary; ошибка безопасно откладывает обновление. Это установлено по локальным shipped исходникам; практическая установка с этой политикой на Linux/macOS остаётся обязательной приёмочной проверкой.

npm 12 перестал использовать `npm-shrinkwrap.json` для фиксации опубликованного дерева; рекомендация npm — `bundleDependencies`. В нашем пакете runtime-зависимости уже bundled. [Changelog npm 12](https://github.com/npm/cli/blob/v12.2.0/CHANGELOG.md).

**Вывод:** staging должен сохранять bundled дерево. Проверять надо итоговый установленный release на платформе пользователя; нельзя предполагать одинаковое дерево нативных/optional зависимостей на Linux и macOS. Изменение npm или Node само по себе не входит в обновление приложения.

### Целостность архива и готовность процесса — разные проверки

Pacote проверяет integrity tarball через SSRI, а content-addressed cache также проверяет digest; при несоответствии возникает `EINTEGRITY`. Это проверено по фактически установленному `pacote/lib/fetcher.js` и первичному репозиторию. [Исходники Pacote](https://github.com/npm/pacote/blob/main/lib/fetcher.js).

**Вывод:** фиксировать exact имя, версию и `dist.integrity`; проверять SHA-512 скачанного `.tgz` перед установкой. SRI подтверждает соответствие полученным registry metadata, но не является независимой подписью автора и не подтверждает работоспособность версии. Установка локального `.tgz` не должна подменять явную проверку ожидаемого registry digest.

В Node `spawn` означает создание процесса; `close` наступает после завершения процесса и закрытия stdio. Для обмена между parent/worker доступен IPC channel. [Документация child_process](https://nodejs.org/api/child_process.html).

**Вывод:** установка завершена только после `close(code=0)` управляемого нами npm-child; `pid`, событие `spawn` и наличие manifest этого не подтверждают. Readiness приложения задаётся отдельным версионированным IPC-протоколом, а не stdout-строкой. Регистрация listeners должна предшествовать возможности получить ранний ответ.

`fs.watch` на Linux/macOS следит за inode: после удаления и создания файла события нового inode могут не прийти. [Node 22 fs.watch: inodes](https://nodejs.org/docs/latest-v22.x/api/fs.html#inodes).

**Вывод:** watcher — ускорение, периодическое чтение manifest по закреплённому пути — обязательный fallback. Отсутствие файла, JSON parse error и кратковременный permission error не являются поводом остановить активный worker. Debounce уменьшает число повторов, но не доказывает завершение внешнего npm.

systemd `Type=simple` не ждёт readiness приложения; `Type=notify` предполагает явное уведомление. `KillMode=control-group` охватывает процессы service cgroup. [systemd.service](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml), [systemd.kill](https://github.com/systemd/systemd/blob/main/man/systemd.kill.xml).

**Вывод:** можно сохранить `Type=simple` и вести worker readiness внутри supervisor. Статус systemd `active` тогда означает живой supervisor, а состояние worker отображается отдельно. При stop supervisor не должен запускать replacement; дети не должны переживать остановку unit. TimeoutStopSec должен покрывать предусмотренный drain и завершение детей.

## Сравнение подходов

| Подход | Простота | Проблема | Решение |
|---|---|---|---|
| postinstall → restart / динамические импорты новой версии | Мало кода | Hooks отключаемы; несовместимое состояние модулей; дерево меняется во время использования; зависимость от sudo | Не выбирать |
| Supervisor копирует global npm-tree после нескольких стабильных poll | Умеренная сложность; работает без повторной загрузки | Debounce не гарантирует целостность; копирование пересекается с reify; platform lifecycle может ещё писать файлы | Допустимо только с полной проверкой snapshot, но это сложнее уверенно доказать |
| Global manifest только обнаруживает желаемую версию; exact registry artifact устанавливается в staging | Дополнительная установка/cache, но ясный критерий готовности | Нужен registry/cache и место; внешняя команда npm не предоставляет свой exit status наблюдателю | **Рекомендуется** |
| Обёртка `hse-harness update` сама запускает global npm и наблюдает exit status | Лучшие гарантии внешней установки | Не совпадает с пожеланием «только npm update» | Опциональный будущий режим строгого управления |

Рекомендация — третий вариант. Он не копирует дерево, которое npm изменяет. Активный worker и управляющий процесс используют собственные immutable releases, поэтому обновление global CLI не затрагивает их файлы.

## Предлагаемый контракт и последовательность

1. При однократном включении режима сохранить absolute global package source path, Node executable и npm executable. Не вычислять текущий prefix через чужое окружение systemd при каждом poll. Путь должен принадлежать ожидаемой установке `@ivan-boss/hse-harness`; `npx` cache и development clone не являются production-источниками обновлений.
2. В каталоге пользователя создать независимый runtime: стабильный bootstrap/supervisor, `releases`, `staging`, versioned journal. systemd ExecStart указывает на стабильный bootstrap вне npm-prefix. Supervisor использует только Node built-ins или свои закреплённые immutable зависимости.
3. Первая управляемая версия создаётся также из **exact опубликованного пакета**, а не из development checkout. Получить metadata exact version, tarball (cache предпочтителен), проверить SRI, установить в уникальный staging на той же машине. Если registry/cache недоступны, не обещать успешный bootstrap: это явная ошибка подготовки, существующий бот не останавливать.
4. Детектор видит новую совместимую версию в global manifest; transient errors игнорируются. Запросить exact metadata из закреплённого trusted registry; никаких автоматических переходов к `latest` сверх увиденной версии. Registry/url/schema контролируются приложением; недоверенный manifest не должен задавать shell-команду или произвольный источник архива.
5. Установка выполняется без shell interpolation в уникальный prefix staging непривилегированным service-user. Bundled зависимости сохраняются. Все npm lifecycle отключены `--ignore-scripts`; необходимый platform bootstrap выполняется отдельно по ограниченной политике выше. Не использовать `dangerously-allow-all-scripts` и не допускать нашу рекурсивную auto-update логику внутри installer.
6. Дождаться npm `close(code=0)`; проверить exact package name/version, release metadata, protocol compatibility, Node/platform requirements и runtime imports. Offline preflight запускается без production Telegram/mail/calendar подключения и без записи учебного состояния. Факт «установка прошла» не заменяет эту проверку.
7. Создать полный installed-release inventory с digest, platform/arch и при необходимости Node ABI. Staging переименовать в immutable release в пределах одной файловой системы. Не использовать hardlinks к изменяемому global tree. Reuse существующего release разрешён только после проверки его identity/inventory; incomplete staging никогда не исполняется.
8. Перед drain перечитать global desired manifest. Если сигнал исчез, npm откатился или версия изменилась — не начинать устаревшее переключение; обрабатывать последний совместимый кандидат последовательно. До этой точки worker продолжает работу.
9. Supervisor запрашивает controlled drain. Только после освобождения writer lock и подтверждённого exit старого worker запускать нового владельца state. IPC `ready` должен содержать release identity, protocol version и incarnation/token текущего child; поздний ответ предыдущего поколения игнорируется.
10. Сохранить подтверждённый active release атомарной записью control state; удерживать предыдущий compatible release для rollback. Ни external npm failure, ни несовместимость кандидата не должны приводить к остановке supervisor. Garbage collection не удаляет active, previous, staging текущей попытки и файлы действующего supervisor.

**Граница гарантии наблюдения:** внешний `npm update` не передаёт exit status supervisor. Даже стабильный manifest может предшествовать последующей ошибке или откату npm. Поэтому корректное обещание для этого режима: «обнаруженная версия проходит независимую установку и проверки перед переключением», а не «supervisor доказал успех внешнего npm». Повторное чтение до drain уменьшает race, но не устраняет эту теоретическую границу. Если нужна строгая связь с успехом внешней команды, её должен запускать контролируемый wrapper. Не скрывать это различие в спецификации и тестах.

## Supervisor и миграция

Обновление пакета не меняет уже исполняющийся supervisor. Первая версия режима должна закрепить совместимый протокол worker/supervisor. Новая application release с неподдерживаемым протоколом отклоняется, старый worker остаётся активным, владелец получает понятное уведомление.

Для security fixes самого supervisor нужна отдельная, явно описанная смена управляющего процесса: кандидат supervisor в новом immutable каталоге, validation, атомарный указатель для следующего запуска и controlled restart/handoff. Перезаписывать текущий supervisor либо загружать его модули из нового npm-tree нельзя. В первой реализации достаточно запретить автоматическую активацию неподдерживаемого протокола и сообщать о необходимом обновлении supervisor.

Текущий пакет **0.1.0** запускает `dist/main.js` напрямую; systemd ExecStart ссылается на npm bin. Ему нельзя задним числом добавить наблюдатель обновлений. После установки версии с этим режимом требуется **одноразовое включение/перезапуск и обновление unit**. После миграции совместимые обновления подхватываются без ручного stop/restart. Это техническое ограничение необходимо обозначить пользователю заранее.

## Что проверить при реализации

- npm 11 и npm 12, `install -g` и `update -g`, hooks disabled; Linux production package и macOS local startup.
- Продолжение старого worker при удалённом, оборванном или временно некорректном global manifest; непрерывность при смене inode.
- Повреждённый tarball, metadata identity mismatch, несовместимый Node/protocol, npm installer exit nonzero, недостаток диска, offline registry с/без cache: ни одного drain до готового кандидата.
- Runtime не обращается к global npm-tree после bootstrap; удаление global install во время работы не убивает уже подготовленный release.
- Exact bundled versions и runtime probes на платформе пользователя; scripts не создают рекурсивный updater и не требуют sudo.
- Две смены manifest подряд, npm rollback во время staging, downgrade/prerelease, повторная установка той же версии: последовательный и ограниченный retry, без restart loop.
- Supervisor crash/reboot во всех фазах journal; отсутствие двух writers; stop unit/CTRL+C отменяет staging и recovery restart.
- Readiness timeout, ранний IPC, IPC предыдущего поколения, worker exit до ready; rollback только к совместимому состоянию данных.
- Обновление unit действительно закрепляет стабильный supervisor path и тот же пользовательский home. Service-user не зависит от root npm cache; cache miss остаётся безопасным отложенным обновлением.

## Область доказательств

Исследование включало Context7, официальные docs/репозитории и чтение реально установленного npm 12.2.0/Pacote и текущих `bin/hse-harness.mjs`, `src/cli/service.ts`, `src/cli/system-service.ts`, `src/main.ts`. Реальная глобальная установка, работающий бот, авторизация и пользовательские секреты не изменялись. Автоматическое обновление ещё не тестировалось end-to-end: пункты выше — требования для реализации и приёмки, а не отчёт об уже пройденных проверках.
