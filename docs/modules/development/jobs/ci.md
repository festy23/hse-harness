# GitHub Actions Check

## Описание

Workflow проверяет качество исходников, поведение приложения, runtime и npm-пакет на Linux и macOS.

## Запуск

Каждый push и pull_request без фильтров paths/branches. Permissions: contents=read. Workflow не публикует npm-пакет и не выполняет deploy.

## Входные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| Checkout | Git revision | Да | Ревизия события GitHub Actions |
| Linux matrix | Две пары версий | Да | Node 22.19.0/npm 11.17.0 и Node 24/npm 12.2.0 |
| RUNNER_TEMP | Каталог | Да | Рабочее хранение benchmark и tarball |

## Результат

Успех требует прохождения quality, обеих Linux matrix jobs и macOS. Ошибка команды делает job неуспешной; зависимые jobs не запускаются. Linux fail-fast=false сохраняет выполнение второй matrix job при отказе первой. При success создаются npm-package-node-22.19.0 и npm-package-node-24; benchmark artifacts загружаются даже при ошибке предыдущего шага, если файл создан.

## Ресурсы

[Команды качества](../operations/quality.md), [сборка/поставка](../operations/package.md), [benchmark](../operations/diagnostics.md), test/, GitHub-hosted runners, npm registry/download cache, GitHub artifacts.

## Алгоритм работы

1. Quality: ubuntu-24.04, timeout 10 min. Checkout через actions/checkout@v7.0.1; setup-node@v7.1.0 с Node 22.19.0 и cache=npm; установить npm 11.17.0; выполнить npm ci, lint, format:check, typecheck, test:quality последовательно.
2. После quality запустить Linux matrix на ubuntu-24.04, timeout каждой 25 min. Checkout/setup-node с версией matrix, установить соответствующий npm; выполнить npm ci, npm test, test:runtime.
3. Запустить benchmark:async с перенаправлением stdout в RUNNER_TEMP/hse-async-benchmark.log. Шаг upload-artifact@v7.0.2 с if=always загружает файл под именем `async-benchmark-linux-node-<matrix.node>`; отсутствие файла даёт warning.
4. После успешных предыдущих обязательных шагов выполнить test:e2e, test:e2e:managed, test:updates, `node --test test/systemd-updates.test.mjs` с HSE_REQUIRE_SYSTEMD=1, test:package, verify-package. Создать RUNNER_TEMP/hse-release, выполнить npm pack с pack-destination и JSON stdout в manifest.json. Загрузить `*.tgz` как `npm-package-node-<matrix.node>`; отсутствие файла — ошибка.
5. После успеха всех Linux jobs запустить macos-14 с timeout 25 min. Checkout/setup-node Node24, npm12.2.0, npm ci, npm test, test:runtime. Benchmark и unconditional upload выполняются как на Linux, имя artifact=`async-benchmark-macos`.
6. Выполнить test:e2e:managed, test:updates, test:package. Скачать npm-package-node-24 через download-artifact@v8.0.2 в RUNNER_TEMP/hse-linux-release. Найти первый tgz и выполнить test:package с HSE_PACKAGE_ARCHIVE, указывающим на этот Linux artifact.

## Фиксация и ошибки

Workflow не задаёт retry commands или concurrency cancellation. Публикация каждого artifact — отдельный побочный эффект, не транзакция с остальными jobs. Download cache не заменяет npm ci. MacOS зависит от полного Linux matrix, а не только Node24. Benchmark сохраняет измерения, но не устанавливает максимальную допустимую задержку.

Источник: [ci.yml](../../../../.github/workflows/ci.yml).
