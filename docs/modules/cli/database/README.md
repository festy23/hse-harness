# Файловые ресурсы CLI

PostgreSQL/Redis отсутствуют. Основная Config и физическая запись секретов принадлежат [Core database](../../core/database/README.md), [persistence](../../core/operations/persistence.md) и [locking](../../core/operations/locking.md).

| Ресурс | Формат | Писатель и момент |
|---|---|---|
| configPath | JSON.stringify(normalizeSetupConfig(config),null,2)+LF | SetupState commit под config write lock |
| envPath | dotenv текст; одна quoted строка на обновлённую переменную | SetupState commit перед config |
| authDir/google.json | `{access_token:string,refresh_token:string,expires_in:number,expires_at:epochMs}` | authorizeGoogle после успешного token exchange; rollback шага восстанавливает backup |
| authDir/pi-auth.json | Pi OAuth storage | Pi login; backup/rollback шага model |
| authDir/telegram.session | Непустая строка SDK session | Telegram discovery после проверки владельца и получения чатов; backup/rollback шага |
| runtimeDir/service.lock | Legacy number либо ownership JSON с pid | Чтение CLI; запись Core |
| `/etc/systemd/system/hse-harness.service` | systemd unit | service install через sudo install -m644 |
| tmpdir/hse-service-* | unit staging, файл0600 | service install; удаляется finally |
| destination.import-UUID | staging импорта | importInstallation; rename в destination после полной копии |

SetupState.root должен по умолчанию быть process.cwd; envPath/configPath должны resolve относительно root с переменными DOTENV_CONFIG_PATH/STUDY_CONFIG либо `.env`/`config.local.json`. authDir должен resolve STUDY_SECRETS_DIR??secrets, runtimeDir — STUDY_DATA_DIR??data. prepare должен создать authDir, runtimeDir и runtimeDir/pi recursive0700.

Нормализация CLI должна сохранять неизвестные верхнеуровневые поля Config. Значения ownerId/chats/folders/model/pollSeconds по умолчанию — 0/[]/[]/''/60. Calendar settings должны определяться [Core](../../core/settings.md). `profile` должен содержать строковые name/university/program/group/academicYear/subjects/details и integer course1..6. Допустимая неполная Config настройки не означает готовность worker.

Для dotenv должны сохраняться посторонние строки и комментарии. Обновление переменной должно удалить все её строки, включая `export NAME=`, и дописать единственную `NAME=<quoted value>` с LF. Семантика quote и транзакции задана [setup-state](../operations/setup-state.md).

Файловая транзакция настройки не является атомарной многофайловой транзакцией при аварийном завершении процесса. CLI должен выполнять описанное компенсационное восстановление при пойманной ошибке. Полные гарантии записи каждого файла должны определяться Core writeSecret.
