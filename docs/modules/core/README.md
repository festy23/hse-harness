# Core

## Назначение

Core задаёт конфигурацию установки, доменные структуры, сохраняемое состояние,
допуск операций worker, бюджеты выполнения и отдельный вычислительный поток.

## Границы ответственности

Core должен сохранять результаты принятия источников до продвижения курсоров,
сериализовать запись operations state и закрывать допуск новых корневых операций
при drain. Он не должен объявлять локальную запись атомарной с внешними Telegram,
календарными или модельными действиями.

## Зависимости

Используются Node.js filesystem, crypto, worker_threads, AsyncLocalStorage,
perf_hooks, dotenv и html-to-text. Прикладные циклы вызывают
[Telegram Bot](../telegram-bot/README.md), [Sources](../sources/README.md),
[Calendar](../calendar/README.md), [Study](../study/README.md),
[Assistant](../assistant/README.md), [Runtime](../runtime/README.md).

## Контракты

- [Файловое состояние и доменные структуры](database/README.md).
- [Настройки](settings.md) и [оперативное состояние](caches.md).
- [Загрузка конфигурации](operations/configuration.md).
- [Сохранение](operations/persistence.md), [блокировки](operations/locking.md).
- [Приём источников и сообщений](operations/ingestion.md).
- [Доменные преобразования](operations/domain.md).
- [Бюджеты и отмена](operations/budgets.md).
- [Вычислительный поток](operations/compute.md).
- [Lifecycle и IPC](operations/worker-control.md).
- [Запуск, циклы и остановка](jobs/worker.md).

Нормативные источники: [store.ts](../../../src/store.ts),
[main.ts](../../../src/main.ts), [domain.ts](../../../src/domain.ts),
[operations.ts](../../../src/operations.ts), [config.ts](../../../src/config.ts).
