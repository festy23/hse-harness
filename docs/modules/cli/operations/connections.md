# Подключения настройки

## Метод

connections lazy adapters; telegram, connectMail/mailFolderChoices, connectModels, connectCalendars/googleCalendarChoices/caldavCalendarChoices/caldavWritable/discoverCalDAVCalendars.

## Описание

Проверить авторизацию и получить допустимые источники/модели/календари без сохранения выбора Config.

## Ресурсы

env secrets, auth files, UI, [Sources](../../sources/README.md), [Calendar](../../calendar/README.md), [Assistant](../../assistant/README.md), [budgets](../settings.md), [Google OAuth](google-auth.md).

## Входные параметры

UI; expectedOwnerId?; reconnect:boolean; calendar provider. TelegramSetupDependencies допускает createClient/sessionPath/networkBudgetMs. Choice должен быть `{id:string,label:string,hint?:string,writable?:boolean}`. Списки должны сохранять указанный ниже порядок.

## Выходные параметры

telegram — `{ownerId:number,chats:Choice[]}`; прочие discovery — Choice[]. bot getMe — username по [HTTP контракту](../http/bot-get-me.md).

## Результат в случае успеха

Авторизация должна сохраняться только в предназначенном auth-файле; выбор Config коммитится вызывающим разделом.

## Результат в случае ошибки

Отмена UI должна сохранять тип SetupCancelled. Неожиданные ошибки внешней системы должны преобразовываться в безопасный SetupIssue соответствующего подключения без вывода SDK/token payload.

## Алгоритм работы

### Telegram MTProto

1. Прочитать telegram.session UTF-8; ENOENT→'', прочая ошибка завершает CONNECT. Прочитать TELEGRAM_API_ID Number и требовать safe integer>0; API_HASH через secret. Создать SDK client из trimmed session и credentials либо createTelegramClient.
2. Организовать один disconnect Promise: destroy, если есть, иначе disconnect; telegramDeadline(budgets.cleanup), ошибку cleanup подавить.
3. Login client.start должен получать callbacks phoneNumber, phoneCode(secret), password(secret), onError. Сетевой budget=networkBudgetMs??budgets.connect должен уменьшаться по performance.now; во время пользовательского input timer остановить, после input возобновить остаток. При expiry выполнить disconnect, отклонить OperationError deadline; дождаться start settle перед завершением.
4. SetupCancelled и SDK AUTH_USER_CANCEL должны преобразовываться в SetupCancelled; SetupIssue сохраняется, остальные login ошибки — CONNECT. После start remaining<=0 — deadline.
5. При наличии client.invoke использовать withOperation(connect,budgets.rpc), users.GetUsers(InputUserSelf), telegramInvoke; первый результат обязан быть Api.User. Для legacy клиента использовать getMe под legacyRequest budget rpc. ownerId=Number(account.id.toString()), safe integer>0. expectedOwnerId и несовпадение — OWNER до discovery/записи session.
6. ui.task должен получить dialogs через telegramDialogs под budgets.addChat и сигналом; legacy — getDialogs({limit:undefined}) с legacyRequest. Legacy request должен racing action с abort/deadline, при ошибке закрыть client и дождаться action settlement; timeout=min(budget,networkBudgetMs??Infinity).
7. Оставить group/channel; каждый id должен быть непустой числовой строкой. По id оставить первую запись; label=title||'Без названия', hint=group?'группа':'канал'. Сортировать по label.localeCompare(...,'ru'). session.save() должен быть непустой строкой; writeSecret session после discovery; вернуть ownerId/chats. В finally всегда disconnect.

### IMAP

1. ui.task должен создать guarded ImapFlow: host imap.yandex.ru, port993, secure=true, logger=false, connectionTimeout20000, socketTimeout30000, auth user=YANDEX_ADDRESS/pass=YANDEX_APP_PASSWORD.
2. mailFolderChoices должен создать operation connect/mailSlice, на abort закрывать client. До/после connect и list проверять parent abort как SetupCancelled, затем operation.throwIfAborted.
3. Фильтровать specialUse `\Trash`, `\Junk`, `\Drafts`; оставшиеся map `{id:path,label:path}` в исходном порядке. В finally снять abort listener, поставить cleanup timer close, logout только usable&&!operation.signal.aborted; logout error подавить; clear timer, close, dispose.
4. connectMail должен сохранить SetupCancelled, остальные ошибки заменить CONNECT с указанием адреса/пароля приложения/IMAP/соединения без secret.

### Pi

1. modelRuntime; если reconnect или !runtime.isUsingSubscription('openai'), loginSubscription с prompt adapter: select→ui.choose(id,label), прочие→ui.input(message,secret для secret/manual_code,signal). Отмену prompt запомнить; notify auth_url/device_code/general message вывести через ui.note.
2. Stage='catalogue'; ui.task должен передать subscriptionModels wrapper fetch с объединением task signal и options.signal??timeout20000. Проверить отмену до/после; map моделей `{id:model.id,label:model.name,hint:model.id}` без сортировки.
3. При отмене вернуть SetupCancelled; остальные ошибки различать по stage login/catalogue безопасным SetupIssue.

### Календари

1. Google: прочитать google.json; ошибка→undefined. При reconnect или !hasGoogleAuth выполнить authorizeGoogle с notify и AbortController от once SIGINT; обработчик снять finally. Затем ui.task и withOperation(connect,calendarScan) должны вызвать [googleCalendarChoices](../http/google-calendar-list.md) через Google.request(path,'GET',undefined,op). Проверять task signal до/после каждого запроса.
2. CalDAV: создать operation connect/calendarScan; createDAVClient с serverUrl `https://caldav.icloud.com` либо `https://caldav.yandex.ru`, credentials соответствующего env, authMethod Basic, defaultAccountType caldav. Fetch должен использовать iCloudFetch/yandexFetch с объединением parent operation signal и options.signal??timeout30000; родительскую отмену преобразовывать в SetupCancelled, собственный deadline — через throwIfAborted; finally dispose.
3. discoverCalDAVCalendars должен fetchCalendars({props:{'d:displayname':{},'d:resourcetype':{},'c:supported-calendar-component-set':{},'d:current-user-privilege-set':{}},projectedProps:{currentUserPrivilegeSet:true}}).
4. caldavCalendarChoices должен исключить явно непустой components без VEVENT. id=url; label=непустой строковый displayName либо 'Календарь без названия'; writable=caldavWritable; hint различает чтение/чтение-запись/неподтверждённое право. Порядок исходного массива сохранить.
5. caldavWritable: не-object/null/array→undefined; нет privilege→false только для пустого объекта, иначе undefined. Привести privilege к массиву; не-object/null/array item→undefined. Собрать имена ключей; all/write либо одновременно bind+unbind+writeContent→true. Непустой Set, целиком в read/readAcl/readCurrentUserPrivilegeSet/writeAcl/writeContent/writeProperties/bind/unbind/unlock→false; иначе undefined.
6. connectCalendars должен сохранить SetupCancelled/SetupIssue, другие ошибки заменить CONNECT с названием provider и без исходных credentials.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| OWNER | SetupIssue | Для другого владельца… | Авторизован другой MTProto пользователь |
| CONNECT | SetupIssue | Не удалось подключить… / получить… | Сеть, credentials, SDK, невалидный результат |
| CANCEL | SetupCancelled | Настройка отменена | Отмена UI/signal |
| DEADLINE | OperationError либо обёрнутый SetupIssue | deadline | Превышение бюджета |
