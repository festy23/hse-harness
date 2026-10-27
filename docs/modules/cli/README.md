# CLI

## Назначение

Модуль должен предоставлять личную установку, интерактивную настройку профиля/интеграций и управление запуском HSE Harness.

## Границы ответственности

CLI должен владеть транзакцией одного шага настройки и терминальным интерфейсом. Настройка должна сохраняться по разделам; отмена текущего раздела не должна отменять ранее завершённые разделы. CLI status должен отражать сохранённые данные; он не должен выдавать их за проверку действующих соединений.

Постоянный публичный HTTP/gRPC сервер CLI не предоставляет. Google OAuth должен временно открывать loopback [GET /callback](http/google-callback.md). CLI не должен менять уже работающую конфигурацию worker в памяти; изменения профиля, источников и календарей применяются при перезапуске.

## Зависимости

- [Core](../core/README.md): Config, календарные роли, writeSecret, config write lock, бюджеты.
- [Runtime](../runtime/README.md): installRuntime, status/settings/requests и стабильный launcher.
- [Sources](../sources/README.md): MTProto/IMAP transport.
- [Calendar](../calendar/README.md): Google/CalDAV adapters.
- [Assistant](../assistant/README.md): Pi subscription login и модели.
- Node child_process, fs, @clack/prompts и Linux systemd для системной службы.

## Контракты

- [Файлы](database/README.md), [настройки](settings.md), [память](caches.md).
- [Команды и меню](operations/commands.md), [транзакция настройки](operations/setup-state.md), [разделы](operations/sections.md).
- [Подключения](operations/connections.md), [авторизация Google](operations/google-auth.md), [отчёт](operations/status.md), [терминал](operations/terminal.md).
- [Запуск](operations/process.md), [systemd](operations/service.md), [импорт](operations/import.md), [обновления](operations/updates.md).
- [Bot getMe](http/bot-get-me.md), [Google authorize URL](http/google-authorize.md), [token exchange](http/google-token.md), [callback](http/google-callback.md), [calendarList](http/google-calendar-list.md).

Периодических jobs CLI не содержит. Конфигурация должна соответствовать реализованным контрактам ревизии `f3bacd3`.
