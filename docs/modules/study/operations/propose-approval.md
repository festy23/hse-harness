# Подготовка внешнего действия

## Метод

`Approvals.propose(kind,payload,now=Date.now(),ctx?) -> Promise<string>`.

## Описание

Сохранение черновика и показ владельцу кнопок решения.

## Ресурсы

[Approval Store](../database/README.md), allowedChats, sender.previewLesson, Bot.send.

## Входные параметры

```yaml
kind: question | lesson
payload:
  chat: string? # question
  text: string? # question
  lessonId: string? # lesson
  start: string? # lesson
  end: string? # lesson
  preview: string? # заменяется previewLesson при наличии sender
now: number # epoch ms, default Date.now()
ctx: OperationContext?
```

## Выходные параметры

Строка id существующего или нового Approval.

## Результат в случае успеха

Внешний вопрос/перенос ещё не исполнять. Для нового Approval показать кнопки, установить notified=true и сохранить.

## Результат в случае ошибки

Если запись создана до ошибки показа, оставить pending/notified отсутствующим; повторный propose с тем же payload должен повторить показ с тем же delivery id. Отдельный фоновый recover pending-not-notified не обрабатывает.

## Алгоритм работы

1. Для question требовать truthy chat, allowedChats.has(chat), truthy text.trim(), text.length<=3500; иначе question-input. Для lesson требовать truthy lessonId/start/end и отсутствие end<=start по JS Date; иначе lesson-input. Нормализация строк времени при вызове из Pi должна выполняться инструментом до propose.
2. Для lesson и существующего sender.previewLesson вызвать его с lessonId,ctx и заменить payload.preview полученной строкой.
3. Найти первый Approval с тем же kind, JSON.stringify(payload) точно равным, state!=rejected и now-created<86400000. При существующем pending&&!notified выполнить Show; затем вернуть id. Для других найденных состояний вернуть id без нового показа.
4. Создать Approval по таблице, push в approvals, Store.save. Выполнить Show; вернуть id.

| Поле Approval | Источник или правило формирования |
|---|---|
| id | randomUUID() |
| kind | Вход |
| payload | Копия payload после preview |
| randomId | 8 random bytes, readBigInt64BE().toString() |
| state | pending |
| created | now |
| notified/sent/messageId/answered | Не задавать |

### Show

1. Для question текст=`Отправить вопрос в чат ${chat}?\n\n${text}`. Для lesson=`Изменить занятие ${lessonId}?\n${preview??''}\nНовый интервал: ${start} → ${end}`.
2. Вызвать bot.send(text,keyboard,`approval:${id}`,ctx); keyboard — одна строка с `{text:'Подтвердить',callback_data:'approve:'+id}` и `{text:'Отклонить',callback_data:'reject:'+id}`.
3. После успеха установить notified=true, Store.save. Остальные поля сохранить.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| question-input | exception | Чат или текст уточнения недопустим | Проверка шага 1 |
| lesson-input | exception | Некорректная правка занятия | Проверка шага 1 |
| dependency | exception | Из preview/Store/Bot | Ошибка внешнего ресурса/записи |
