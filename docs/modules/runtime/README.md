# Runtime

## Назначение

Модуль должен устанавливать проверенные неизменяемые выпуски, запускать единственный worker и применять установленную пользователем npm-версию с восстановлением после перезапуска.

## Границы ответственности

Модуль должен владеть runtime journal, стабильным launcher, деревьями releases/engines, настройками применения обновлений, supervisor IPC и предложениями npm-обновления в Telegram. Учебное состояние и worker должны использовать [Core](../core/README.md). Модуль не должен откатывать учебные данные при откате исполняемого выпуска. Глобальная npm-установка должна оставаться отдельной от работающей копии.

## Зависимости

- Node.js, npm, локальная POSIX файловая система и сигналы процессов.
- [CLI](../cli/README.md) для первоначальной установки, управления политикой и systemd.
- [Telegram Bot](../telegram-bot/README.md) для проверки владельца и устойчивой доставки уведомлений.
- [Core persistence](../core/operations/persistence.md), [worker control](../core/operations/worker-control.md) и [worker](../core/jobs/worker.md).

## Контракты

- [Физические файлы и блокировки](database/README.md), [настройки](settings.md), [память процесса](caches.md).
- [Установка runtime](operations/installation.md), [контроль файлов](operations/storage.md), [манифест](operations/manifest.md), [подготовка выпуска](operations/releases.md).
- [IPC](operations/ipc.md), [переключение и восстановление](operations/switch.md), [supervisor](jobs/supervisor.md).
- [Согласование Telegram](operations/telegram-updates.md), [периодическая обработка](jobs/telegram-updates.md), [глобальная установка](operations/npm-install.md).
- [Метаданные версии](http/version.md), [архив](http/archive.md), [latest](http/latest.md).

Контракты должны соответствовать ревизии `f3bacd3`. gRPC и постоянный HTTP-сервер модуль не предоставляет.
