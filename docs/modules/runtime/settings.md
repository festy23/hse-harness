# Настройки Runtime

| Название | Тип | Обязательность | Значение по умолчанию | Описание |
|---|---|---|---|---|
| `home` | absolute path | да | нет | Личный каталог |
| `node` | absolute path | нет | process.execPath | Node для worker/проверок |
| `npm` | absolute path | ReleaseStore: да | installRuntime: findNpm | Исполняемый npm |
| `registry` | URL | нет | https://registry.npmjs.org/ | HTTPS либо HTTP loopback; без credentials/query/hash |
| `timeout` | milliseconds | нет | 180000 | Одна загрузка и installer ReleaseStore |
| `bootstrap` | boolean | нет | true | Разрешить только проверенный esbuild install.js |
| `pollMs` | milliseconds | нет | 10000 | Пауза supervisor между ticks |
| `drainMs` | milliseconds | нет | 120000 | Ожидание quiescent |
| `bootMs` | milliseconds | нет | 30000 | prepare и activate/resume по отдельности |
| `finishMs` | milliseconds | нет | 30000 | Подтверждение выхода child |
| `probationMs` | milliseconds | нет | 120000 | Непрерывная работа кандидата до commit |
| `heartbeatMs` | milliseconds | нет | 30000 | Допустимый возраст health; block при `age > limit` |
| `deferMs` | milliseconds | нет | 600000 | Повтор занятого drain |
| `debounce` | integer | нет | 3 | Число последовательных наблюдений установленной версии |
| `retryMs` | milliseconds[] | нет | [10000,30000,60000] | Задержки восстановления; candidate/active используют первые две |
| `STUDY_DATA_DIR` | path | нет | home/data | operations.json и worker service.lock |
| `HSE_WORKER_ID` | UUID | worker: да | генерируется | ID запуска worker |
| `HSE_SUPERVISOR` | string | managed worker: да | '1' | Режим IPC |
| `HSE_RELEASE_VERSION`, `HSE_RELEASE_INTEGRITY` | string | managed worker: да | из descriptor | Выпуск worker |
| `settings.enabled` | boolean | нет | true | Политика автоматического применения |

Конструктор Supervisor должен принимать внедряемые `releaseStore`, `spawn`, `workerEnv`, `stdio`, `clock`, `log`; они должны заменять соответствующий адаптер, а не сохраняться в журнал. Реальный clock probation/heartbeat должен быть performance.now, retry — Date.now. Системные бюджеты worker принадлежат [Core](../core/settings.md).

Лимиты должны быть: JSON 16 MiB по умолчанию, operations.json при switch 128 MiB, metadata версии 1 MiB, архив 64 MiB, распакованный поток 500 MiB, один архивный member не более 64 MiB, резерв диска 750 MiB, installer output 1 MiB, IPC сериализованное сообщение 65536 символов, notices 50 записей. Подготовка должна повторяться с задержками 60000, 300000, 900000, затем 3600000 ms. npm install из Telegram: 300000 ms, fetch timeout npm 120000 ms; latest discovery: 15000 ms; refresh latest: 1 час; автоматическое предложение: раз в 24 часа; ошибка discovery: повтор через 60000 ms.
