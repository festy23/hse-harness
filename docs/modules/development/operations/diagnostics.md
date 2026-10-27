# Измерения и запись CLI

## Контракт

`benchmark:async` выводит показатели локальных синтетических нагрузок без порога pass/fail по задержке. `record-cli-demo.py` создаёт GIF из настоящего CLI с временным вымышленным профилем. Команды не являются проверкой реальных Telegram/IMAP/календарных аккаунтов.

## Ресурсы

[Артефакты](../database/README.md), [ComputeClient](../../core/operations/compute.md), Store, PiAssistant и SessionManager; для demo — POSIX PTY, pyte, Pillow, wcwidth, локальные шрифты, временная конфигурация и `scripts/harness.mjs`.

## Алгоритм работы benchmark

1. Запустить npm run build в root с inherited stdio. Дождаться exit; ненулевой code завершает benchmark с тем же code, null — с 1. После успеха импортировать dist/PiAssistant, ComputeClient, Store и SessionManager.
2. Вывести JSON host: node=process.version, platform, arch, cpu=первая модель CPU, memoryGiB=totalmem/2^30 с одним десятичным знаком, note об ограничении синтетических fixtures и сохранении Pi persistence/JSON snapshots на главном потоке.
3. Для каждого измерения запустить setInterval 1 ms; сохранять elapsed между ticks, max и число ticks. Подождать 5 ms, зафиксировать start, await run, вычислить elapsed, подождать ещё 5 ms, очистить timer. Вывести JSON по таблице.

| Поле | Формирование |
|---|---|
| name | Имя нагрузки |
| elapsedMs | Время await run с двумя десятичными знаками |
| maxTimerGapMs | Максимальный gap interval с двумя знаками |
| p95TimerGapMs | Сортированные gaps[max(0,ceil(length×0.95)−1)] либо 0, два знака |
| timerTicks | Количество ticks |
| Дополнительные поля | Результат конкретной нагрузки |

4. Последовательно выполнить нагрузки: поиск отсутствующей строки в 10000 Pi custom entries с повторённым текстом; 100 одновременных save + flush для MemoryStore с 12800 outbox entries по 4096 символов; преобразование HTML около 999000 bytes в отдельном worker; 20 последовательных раскрытий hourly recurrence на диапазоне 01.10–01.11.2026. MemoryStore.persistSnapshot только считает writes и ждёт setImmediate; filesystem durability этим измерением не проверяется.
5. Вернуть matches для поиска, writes/requestedSaves для Store, inputBytes/outputCharacters для HTML, occurrences для календаря. В finally закрыть ComputeClient. Ошибка нагрузки передаётся наружу без retry; performance thresholds отсутствуют.

## Алгоритм работы записи CLI

1. Создать временный каталог `hse-cli-demo-*` и empty.env. Запустить node scripts/harness.mjs через PTY 90×54 с cwd=temp. Удалить из environment переменные с префиксами TELEGRAM_/YANDEX_/ICLOUD_/GOOGLE_/STUDY_/DOTENV_ и NO_COLOR/NODE_DISABLE_COLORS; установить DOTENV_CONFIG_PATH, STUDY_CONFIG, STUDY_DATA_DIR, STUDY_SECRETS_DIR внутри temp, TERM=xterm-256color, COLORTERM=truecolor, FORCE_COLOR=3.
2. Читать PTY в chunks до 65536 bytes и записывать `(monotonicTime−START, bytes)` в EVENTS. Expect ищет UTF-8 подстроку с timeout 12 s; отсутствие ожидаемого prompt — ошибка. Type отправляет символы с паузой 65 ms, затем 280 ms и Enter.
3. Дождаться главного меню, выбрать настройку профиля двумя стрелками вниз. Заполнить имя Анна, программу «Прикладная математика», группу БПМИ251, курс 2, предметы «Алгебра, Математический анализ»; для вуза, учебного года и дополнительных сведений принять пустой ввод. Дождаться сохранения и главного меню. Закрыть CLI.
4. Прочитать config.json, потребовать name=Анна, course=2, пустые chats и ownerId. Снова открыть CLI, потребовать «Сохранено 1/5» и главное меню, записать паузу и закрыть. После закрытия TemporaryDirectory удаляется.
5. Close отправляет Ctrl+C живому процессу, ждёт до 5 s с чтением вывода, затем при необходимости SIGKILL группе; wait timeout 5 s, закрытие master fd в finally.
6. Render воспроизводит EVENTS через incremental UTF-8 decoder и pyte.Screen с шагом 100 ms. Для variation selector дополняет предыдущую ячейку и учитывает wcwidth. HSE_DEMO_FONT либо Menlo 14 используется для текста; существующий Apple Color Emoji — для emoji, glyph cache 18×18. Размер кадра 858×1096; терминальная ячейка 9×19, поля 24×50.
7. Нарисовать рамку, заголовок, ANSI foreground/background, reverse, block symbols, underline и cursor. В первом кадре потребовать подписи Telegram, Яндекс Почта и «Настроить всё по шагам». Идентичные RGB кадры объединить увеличением duration на 100 ms.
8. Построить palette 256 цветов из трёх кадров, квантовать без dithering. Создать docs/assets при отсутствии, сохранить GIF loop=0, optimize=true в cli-setup.gif и вывести число кадров, duration и размер файла.

## Ошибки и фиксация

Benchmark и demo не задают общий timeout. Ошибка PTY/prompt/assertion/font/import/build или записи завершает команду; повторов нет. Demo может запускать установку зависимостей через harness. Изменение GIF не атомарно с записью терминала; ошибочный render не восстанавливает ранее существовавший GIF. Временные пользовательские настройки удаляются при выходе из TemporaryDirectory.

Источники: [benchmark](../../../../scripts/benchmark-async.mjs), [record-cli-demo](../../../../scripts/record-cli-demo.py).
