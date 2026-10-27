# Запуск исходного checkout

## Контракт

`scripts/harness.mjs` принимает argv команды CLI и подготавливает зависимости checkout перед импортом TypeScript entrypoint. Возвращает результат CLI либо ошибку подготовки. `hse` является shell entrypoint этой команды.

## Ресурсы

package.json, package-lock.json, node_modules, [stamp](../database/README.md), npm, [runProcess](../../cli/README.md), [CLI](../../cli/README.md).

## Алгоритм работы

1. Разобрать process.versions.node на major/minor. Допустить major>22 либо major=22 и minor≥19; иначе вывести требование версии, установить exitCode=1 и завершиться.
2. Изменить cwd на root проекта. Прочитать package-lock и package.json; вычислить SHA-256 исходного UTF-8 текста lockfile.
3. Для каждой прямой dependencies/devDependencies прочитать node_modules/name/package.json. ENOENT означает, что установка нужна; прочие ошибки передаются. Отсутствующая или отличная от lock version также требует установки.
4. Если все прямые версии совпали и stamp существует, считать зависимости готовыми только при stamp===fingerprint. При отсутствии stamp прочитать node_modules/.package-lock.json; отсутствие требует установки. Для каждой lock.packages записи, кроме root и отсутствующей optional, сравнить version и integrity с existing packages. Любое несовпадение требует установки.
5. При необходимости вызвать runProcess с args `ci --include=dev --no-audit --no-fund`, cwd=root. При наличии npm_execpath command=process.execPath, args=[npm_execpath,...]; иначе Windows использует ComSpec/cmd.exe и `/d /s /c`, остальные платформы — npm. Environment наследуется. Отдельный timeout и retry не заданы.
6. Если дочерний код ненулевой, перенести его в process.exitCode, для кодов кроме 130/143 вывести диагностику установки и завершиться без запуска CLI. При успехе продолжить; повторной полной проверки installed после npm ci нет.
7. Если stamp отличается, записать fingerprint с mode 0600. Динамически импортировать tsx/esm/api, вызвать tsImport `../src/cli.ts` и `cli.main(args)`.
8. При самостоятельном запуске entrypoint проверяется через realpath argv[1]. Ошибка main выводит общую диагностику файлов/прав/Node/npm и exitCode=1. При импортированном main ошибка передаётся вызывающему.

## Фиксация и ошибки

npm ci меняет node_modules; неудача не откатывает предыдущую установку. Stamp записывается только после успешной подготовки, но без atomic rename. При неизменном stamp не проверяется integrity каждого установленного файла. Ошибки JSON, чтения, записи и импорта не повторяются автоматически.

Источник: [harness.mjs](../../../../scripts/harness.mjs), [hse](../../../../hse).
