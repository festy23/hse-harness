# Сохранённый статус и доступ к Telegram

## Метод

setupReport(state,pid?,env=process.env,authDir=state.authDir), hasSubscription, hasGoogleAuth, showTelegramAccess.

## Описание

Показать заполненность локальной установки без внешних запросов.

## Ресурсы

SetupState.config, env, telegram.session/pi-auth.json/google.json, UI.note, [runtime summary](updates.md).

## Входные параметры

state — загруженный SetupState; pid — необязательный результат runningPid; env/authDir — overrides. showTelegramAccess принимает только ownerId/chats и UI.note.

## Выходные параметры

SetupReport должен быть `{rows:StatusRow[],completed:number,total:number,pid?:number,name?:string}`; StatusRow `{id,title,ready,detail}`. Rows обязаны идти profile,telegram,mail,model,calendars; completed=count ready, total=5, pid=аргумент, name=config.profile?.name.

## Результат в случае успеха

Report должен показывать наличие сохранённых данных. Истечение токенов и доступность удалённых систем этими predicates не проверяются.

## Результат в случае ошибки

Ошибки чтения auth должны означать пустое содержимое; невалидный JSON — undefined, без создания/исправления файла.

## Алгоритм работы

1. Параллельно прочитать три auth файла; применить правило отсутствия выше. hasSubscription должен требовать объект openai с type='oauth', непустыми string access/refresh и finite number expires. hasGoogleAuth должен требовать непустые string access_token/refresh_token и finite number expires_at.
2. Вычислить calendar label: пустой id либо startsWith('your-')→'не выбран'; непустой label→`label (Google|Яндекс|iCloud)`, иначе `provider · календарь выбран`. Provider ready: Google требует clientId/clientSecret/hasGoogleAuth, Yandex/iCloud — обе credential env.
3. Сформировать rows:

| id | ready | detail |
|---|---|---|
| profile | Boolean(config.profile) | group · course курс · academicYear либо предложение заполнить курс/предметы |
| telegram | bot token, api id/hash, ownerId, session.trim все truthy | количество chats и наличие владельца |
| mail | address и password truthy | folders.join(', ') либо все учебные; при отсутствии address — не настроена |
| model | hasSubscription и непустой model без choose- | наличие входа и выбранный model либо модель не выбрана |
| calendars | обе роли выбраны и credentials обоих providers готовы | timetable/agent labels, при отсутствии login просьба подключить аккаунт |

4. showTelegramAccess должен показать ownerId и личный характер команд; без owner — сообщение о необходимости настройки. Без chats вывести отсутствие источников и завершить. Иначе перечислить исходный порядок с номером1+, title, id и чтением; allowQuestions===false→только чтение, иначе вопрос после подтверждения.
5. Для непустого списка дополнительно вывести: чтение личным аккаунтом, отправка после подтверждения от аккаунта, запрет чатов вне списка, необходимость Telegram прав и факт отсутствия live-проверки. Секреты и session не выводить.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| INPUT | исключение caller | invalid config | Операция требует нормализованный Config |
