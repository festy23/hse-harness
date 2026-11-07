# Настройки

| Название | Тип | Обязательность | Значение по умолчанию | Описание |
|---|---|---|---|---|
| Node.js | Semver | Да | `>=22.19.0` | engines и минимальная проверка harness |
| package version | Stable semver | Да | `0.3.0` | Текущее значение metadata |
| npm registry | URL | Да при публикации | `https://registry.npmjs.org/` | publishConfig |
| npm access | Строка | Да при публикации | `public` | publishConfig |
| `npm_execpath` | Путь | Нет | Не задан | npm CLI для дочернего node harness |
| `ComSpec` | Путь | Только fallback Windows | `cmd.exe` | Запуск npm без npm_execpath |
| `STUDY_EVAL_MODEL` | Строка | Для eval | Нет | ID модели подписочного OpenAI каталога |
| `HSE_DEMO_FONT` | Путь | Нет | `/System/Library/Fonts/Menlo.ttc` | Шрифт записи CLI |
| `HSE_REQUIRE_SYSTEMD` | Строка | В Linux CI | `1` в соответствующем шаге | Обязательность systemd проверки |
| `HSE_PACKAGE_ARCHIVE` | Путь | Для cross-OS проверки | Не задан | Полученный Linux tarball |

Конфигурации compiler/linter/formatter определены в [quality](operations/quality.md). Переменные совместимости определены в [compatibility](operations/compatibility.md). Версии Node/npm и лимиты CI — в [job](jobs/ci.md).
