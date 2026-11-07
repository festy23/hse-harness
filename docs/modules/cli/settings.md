# Настройки CLI

| Название | Тип | Обязательность | Значение по умолчанию | Описание |
|---|---|---|---|---|
| HSE_HARNESS_HOME | path | npm launcher: нет | ~/.hse-harness | Абсолютный home после resolve |
| DOTENV_CONFIG_PATH | path | нет | home/.env в bin, root/.env в SetupState | dotenv |
| STUDY_CONFIG | path | нет | home/config.local.json либо root/config.local.json | Настройки |
| STUDY_DATA_DIR | path | нет | home/data либо root/data | Память |
| STUDY_SECRETS_DIR | path | нет | home/secrets либо root/secrets | Авторизации |
| TELEGRAM_BOT_TOKEN | secret string | шаг Telegram | нет | Личный бот |
| TELEGRAM_API_ID | positive integer string | шаг Telegram | нет | MTProto app |
| TELEGRAM_API_HASH | secret string | шаг Telegram | нет | MTProto app |
| YANDEX_ADDRESS | email string | шаг mail | нет | IMAP user |
| YANDEX_APP_PASSWORD | secret string | шаг mail | нет | IMAP app password |
| GOOGLE_CLIENT_ID | nonempty string | Google | нет | Desktop OAuth client |
| GOOGLE_CLIENT_SECRET | secret string | Google | нет | OAuth secret |
| YANDEX_CALENDAR_USERNAME | string | Yandex calendar | YANDEX_ADDRESS как initial prompt | Отдельная календарная авторизация |
| YANDEX_CALENDAR_APP_PASSWORD | secret string | Yandex calendar | нет | Пароль приложения Календарь |
| ICLOUD_USERNAME | string | iCloud | нет | Apple Account |
| ICLOUD_APP_PASSWORD | secret string | iCloud | нет | App-specific password |
| GoogleAuthOptions.port | integer0..65535 | нет | 8765 | Loopback listener;0 выбирает свободный порт |
| GoogleAuthOptions.timeoutMs | finite number>0 ms | нет | 300000 | Весь OAuth flow |
| TERM | string | нет | process.env | dumb отключает анимацию/brand |
| NO_COLOR, FORCE_COLOR | string | нет | process.env | NO_COLOR либо FORCE_COLOR='0' задаёт monochrome |

Проверка Bot getMe должна иметь timeout20000 ms; Google token request —20000 ms и общий OAuth lifetime; IMAP connection/socket —20000/30000 ms; подписной catalogue fetch без своего signal —20000 ms; CalDAV fetch без своего signal —30000 ms. Общие сетевые бюджеты `connect`, `rpc`, `addChat`, `mailSlice`, `calendarScan`, `cleanup` должны браться из [Core settings](../core/settings.md).

CLIDependencies должен разрешать внедрение state/ui/connections/service/view/interactive/print; это порты выполнения, а не сохраняемая конфигурация. SetupConnections должен содержать bot(token,ui), telegram(ui,expectedOwnerId?), mail(ui), models(ui,reconnect), calendars(provider,ui,reconnect).
