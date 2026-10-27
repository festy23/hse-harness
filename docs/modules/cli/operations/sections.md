# Разделы настройки

## Метод

Onboarding.run(section), credential; шаги profile, telegram, mail, model, calendars.

## Описание

Изменить один раздел профиля или подключений.

## Ресурсы

[SetupState transaction](setup-state.md), [connection adapters](connections.md), [UI](terminal.md), auth backups, config, env.

## Входные параметры

section — profile|telegram|mail|model|calendars. StepContext должен передавать state,ui,connections,credential. CredentialRequest должен содержать name,message, необязательные secret/initial/validate.

## Выходные параметры

void; поля Config/env/auth должны сохраняться commit раздела.

## Результат в случае успеха

Только текущий раздел должен коммититься после успешного завершения всех его проверок/выборов. Внешний вход может создать auth до commit, поэтому соответствующий backup должен быть зарегистрирован заранее.

## Результат в случае ошибки

Любая ошибка/SetupCancelled должна выйти из action transaction и применить [компенсацию](setup-state.md).

## Алгоритм работы

1. run должен создать StepContext и вызвать `transaction(() => steps[section](context))`. credential: при непустом env value, отсутствии validation error и подтверждении yes(initial=true) вернуть сохранённое без изменения; иначе input с secret, validate, initial=undefined для secret либо existing??request.initial; state.env(name,value), вернуть value.
2. profile должен последовательно спросить name, university, program, group, course, academicYear, subjects, details. Initial — старое поле; university без старого 'ВШЭ ФКН'; details optional. Course input regex `^[1-6]$`, преобразовать Number; academicYear regex `^\d{4}/\d{2}$`; default academicYear: год текущего local Date, если month>=8, иначе прошлый, затем `/` и последние2 цифры следующего. Передать полный объект state.profile.
3. telegram:
   1. credential TELEGRAM_BOT_TOKEN secret; connections.bot→username. Credential TELEGRAM_API_ID должен matching `^[1-9]\d*$`; API_HASH secret.
   2. protectAuth telegram.session до входа; connections.telegram(ui,config.ownerId||undefined); при уже сохранённом ином owner — OWNER.
   3. Сохранённые chats, отсутствующие в discovery, добавить к choices с прежним title и hint недоступности. ui.many с прежними IDs; доступность не должна автоматически удалять источник.
   4. config.ownerId=account.ownerId; config.chats=selected IDs в порядке результата, каждый `{...oldById,id,title:choice.label}`. Сохранить allowQuestions и другие существующие поля. state.save; показать количество и ссылку t.me/username.
4. mail: credential YANDEX_ADDRESS с regex `^[^\s@]+@[^\s@]+\.[^\s@]+$`; secret YANDEX_APP_PASSWORD; connections.mail; ui.many с config.folders initial; config.folders=result; save. Пустой выбор должен оставаться [] и означать выбор папок на уровне [Sources](../../sources/README.md).
5. model: yes reconnect initial=false. Прочитать pi-auth.json/JSON; ошибка чтения/парсинга означает undefined. При reconnect либо !hasSubscription protectAuth pi-auth.json. connections.models; пустой список — EMPTY. ui.choose с initial config.model; config.model=выбранный id, save.
6. calendars:
   1. Выбрать timetableProvider, затем agentProvider из google/yandex/icloud; initial старые роли. Для каждого уникального provider выполнить credentials и один discovery, сохранив список Map; пустой список — EMPTY.
   2. Google credentials: запросить clientId/clientSecret; если прежнее непустое значение одного изменилось, reconnect=true; иначе yes reconnect=false. При reconnect либо !hasGoogleAuth прочитанного google.json защитить backup до connections.calendars.
   3. Yandex credentials: username initial=YANDEX_ADDRESS и отдельный calendar app password; iCloud: username/app password. Для обоих reconnect=false.
   4. Выбрать timetableId из всего списка выбранного provider; initial старый id только при неизменном provider. Agent options должны исключить writable=false и тот же id, если provider совпадает. Пустой результат — EMPTY.
   5. Выбрать agentId, initial старый только при неизменном provider. Если writable===undefined, запросить подтверждение права записи initial=false; отказ — PERMISSION.
   6. state.calendars должен получить полные `{provider,id,label}` обеих ролей; label брать из выбранных choices. Запись в сами календари во время выбора отсутствует.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| OWNER | SetupIssue | Для другого владельца используй отдельную установку | Запрет смены владельца |
| EMPTY | SetupIssue | Нет доступных календарей / По подписке нет моделей / Создай отдельный календарь… | Нет допустимого выбора |
| PERMISSION | SetupIssue | Выбери календарь с правом записи | Не подтверждено неизвестное право |
| CANCEL | SetupCancelled | Настройка отменена | Отмена UI |
| RESOURCE | rejected Promise | Ошибка зависимой операции | Компенсация раздела |
