# Контроль качества

## Контракт

`npm run lint`, `format:check`, `typecheck` и `check` завершаются с кодом 0 только при успехе всех входящих последовательных команд. `lint:fix` и `format` изменяют файлы. Общая область Oxlint/Oxfmt: `src test runtime scripts deploy bin`; собственный comment policy обходит весь checkout с исключениями ниже.

## Ресурсы

[Настройки](../settings.md), исходные файлы, `.oxlintrc.json`, `.oxfmtrc.json`, `tsconfig.json`, `tsconfig.check.json`, Python 3 и локальные npm executables.

## Алгоритм работы

1. `lint` запускает code-policy, затем при успехе Oxlint. Code-policy обходит root из argv[2] либо cwd. Пропускает symlinks, `.git` и `node_modules` на любой глубине; на уровне root также `.agents`, `dist`, `coverage`, `data`, `secrets`, `docs`. Сортирует пути файлов с расширениями js/mjs/cjs/ts/mts/cts/tsx/jsx/py.
2. Для JS/TS вызвать oxc-parser.parseSync(filename, source). Каждая parse error и каждый comment, кроме совпадающего по start/end с hashbang, — отдельное нарушение. Номер строки comment вычисляется числом LF до его start плюс 1. Строковые литералы с символами комментария не являются comment.
3. Для всех Python файлов запустить один `python3 scripts/python-code-policy.py <files>`. Читать код через tokenize.open, разобрать ast и tokens. Запретить COMMENT, кроме shebang с позиции (1,0); запретить docstring Module/ClassDef/FunctionDef/AsyncFunctionDef. SyntaxError/TokenError — нарушение. Отсутствие python3 — ошибка команды, а не пропуск проверки.
4. Пустой список исходников — ошибка. При нарушениях вывести path/line/message и exit code 1; иначе вывести количество просмотренных файлов и успех.
5. Oxlint включает typescript/import/oxc plugins, typeAware=true, denyWarnings=true. Категория correctness целиком отключена; применяются явно перечисленные правила `.oxlintrc.json`. Общие правила запрещают eval/dynamic Function, async Promise executor, небезопасный finally/optional chaining, неоднозначные сравнения, var, дубли, fallthrough, недостижимые ветви, циклические runtime imports, self-import, explicit any и TypeScript suppression comments; требуют braces и const. `no-await-in-loop` выключен; constant-condition допускает циклы.
6. Для JS/mjs/cjs дополнительно проверять no-undef и no-const-assign. Только для `src/**/*.ts` применять type-aware запреты floating/misused promises, await non-thenable, unsafe any assignment/argument/call/member/return, throw non-Error; проверку switch exhaustiveness и max-depth 4. Для no-floating-promises задать ignoreVoid=false и checkThenables=true: префикс void не освобождает от проверки, thenable также проверяются. В том же src override действуют no-misused-new, no-for-in-array и no-duplicate-type-constituents. Тестовые TS входят в общие правила, но не в этот override.
7. Для `src/domain.ts` запретить импорты транспорта, store, CLI, updates, mail/main и Node fs/http/https/child_process согласно точным patterns конфигурации. Правило проверяет указанные пути импортов, не доказывает архитектурную независимость всех файлов проекта.
8. `typecheck` запускает `tsc --noEmit -p tsconfig.check.json`. Основная конфигурация: ES2023, NodeNext module/resolution, ES2023+DOM libs, strict, noUncheckedIndexedAccess, noImplicitReturns/Override, noUnusedLocals/Parameters, noFallthroughCasesInSwitch, allowUnreachableCode=false, skipLibCheck=true. Проверочная конфигурация включает src/test TS, rootDir `.`, allowJs=true, checkJs=false. Произвольные JS-скрипты не получают полноценную TypeScript проверку.
9. Oxfmt применяет singleQuote=true, printWidth=100, semi=true, tabWidth=2, sortImports=false. Игнорирует node_modules/dist/.agents/docs/coverage/data/secrets и package-lock. Check не записывает результат; format записывает форматирование. Lint:fix запускает только Oxlint --fix и не заменяет полный lint с comment policy.
10. `check` последовательно запускает lint → format:check → typecheck → test:quality → npm test → test:runtime; npm test сначала выполняет pretest build. Неуспех прерывает оставшуюся цепочку. E2E, package и live eval не входят в check.

## Ошибки и фиксация

| Ошибка | Результат |
|---|---|
| Policy, lint, formatting или type diagnostic | Ненулевой exit; дальнейшие команды цепочки не выполняются |
| Не читается файл, недоступен parser/Python/compiler | Ошибка команды без автоматического повтора |
| Ошибка изменяющего format/lint:fix | Уже записанные изменения не откатываются |

Источник: [policy](../../../../scripts/code-policy.mjs), [Python policy](../../../../scripts/python-code-policy.py), [Oxlint](../../../../.oxlintrc.json), [TypeScript](../../../../tsconfig.json), [check config](../../../../tsconfig.check.json), [Oxfmt](../../../../.oxfmtrc.json).
