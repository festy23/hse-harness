# Артефакты разработки

SQL-хранилище отсутствует. Файлы разрешено менять только соответствующим генераторам и командам установки/сборки.

| Ресурс | Формат и писатель | Чтение и срок жизни |
|---|---|---|
| `package.json` | JSON: metadata, scripts, engines, dependencies, devDependencies, bundleDependencies, files, publishConfig | npm и скрипты подготовки; версионируется |
| `package-lock.json` | npm lock: точные версии, integrity, locations, inBundle, bin | npm ci, проверка состава и fingerprint; версионируется |
| `node_modules/.hse-harness-lock` | SHA-256 UTF-8 содержимого package-lock, без перевода строки; writeFile mode 0600 | harness; перезаписывается после успешной проверки/установки |
| `dist/` | JS, полученный TypeScript из `src/**/*.ts` | CLI, worker, runtime, проверки; build не очищает каталог предварительно |
| `runtime-manifest.json` | Формат [manifest](../../runtime/README.md); JSON с завершающим LF, mode 0644 | Пишет create-runtime-manifest; читают installer/supervisor |
| npm tarball | npm pack, публичный пакет `@ivan-boss/hse-harness` | Установка и проверка переносимости |
| `docs/assets/cli-setup.gif` | GIF: запись PTY через генератор CLI | README; перезаписывается генератором |
| CI benchmark log | Построчный JSON и вывод build | RUNNER_TEMP; загружается как workflow artifact |

Сборка, нормализация bin, создание manifest и npm pack не составляют транзакцию. Ошибка последующего шага оставляет уже созданные файлы. Ни одна из этих команд не публикует пакет сама по себе.
