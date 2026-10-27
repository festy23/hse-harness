# Development

## Назначение

Модуль определяет сборку исходников, контроль качества, подготовку npm-пакета и служебные команды разработчика.

## Границы ответственности

Команды работают с исходным checkout и артефактами поставки. Они не изменяют правила учебных задач. Проверка качества ограничивается явно включёнными правилами: автоматическое доказательство SOLID, бизнес-корректности или безопасности зависимостей не предоставляется.

## Зависимости

Node.js, npm, TypeScript, tsx, Oxlint с type-aware движком, Oxfmt, oxc-parser, Python 3; GitHub Actions для CI; Pi для eval; pyte/Pillow/wcwidth для записи CLI. Runtime-формат поставки определяется [Runtime](../runtime/README.md), вход в интерфейс — [CLI](../cli/README.md).

## Контракты

- [Артефакты](database/README.md), [настройки](settings.md), [кэши](caches.md).
- [Сборка и поставка](operations/package.md).
- [Контроль качества](operations/quality.md).
- [Подготовка запуска из исходников](operations/harness.md).
- [Оценка памяти модели](operations/evaluation.md).
- [Измерения и запись CLI](operations/diagnostics.md).
- [Совместимость старых релизов](operations/compatibility.md).
- [GitHub Actions](jobs/ci.md).

Источники: [package.json](../../../package.json), [scripts](../../../scripts), [deploy](../../../deploy), [CI](../../../.github/workflows/ci.yml).
