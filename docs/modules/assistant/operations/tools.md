# Контракт инструментов Pi

## Метод

`studyTools(dependencies) -> ToolDefinition[]`; `execute(toolCallId,args,signal)` каждого инструмента.

## Описание

Ограниченный доступ модели к учебным операциям.

## Ресурсы

Calendar, Approvals, Bot, Scheduler, Store, PiAssistant, TelegramSource. Source: [tools.ts](../../../../src/tools.ts).

## Входные параметры

Аргументы каждого инструмента должны соответствовать его TypeBox-схеме; signal должен поступать из SDK. toolCallId в wrapper не используется для idempotency. Схемы должны определять обязательность всех полей, кроме явно optional.

## Выходные параметры

| Поле результата | Источник или правило формирования |
|---|---|
| content | Массив из одного элемента `{type:'text',text:JSON.stringify(result)}` |
| details | {} |

## Результат в случае успеха

Вернуть оболочку над результатом конкретного инструмента. label должен совпадать с name, executionMode=sequential.

## Результат в случае ошибки

Пробросить исключение из операции в SDK; wrapper не должен превращать ошибку в успешный JSON. Результаты модели и источников не должны давать права произвольного внешнего действия.

## Алгоритм работы

1. Открыть withOperation(kind=tool,parent=SDK signal), budget: read_hse=45000, add_telegram_chat=120000, read_chat_history=45000, остальные=90000 ms. При уже отменённом signal внешнюю работу не начинать.
2. Вызвать конкретный обработчик args,ctx; дождаться его Promise.
3. JSON.stringify результата, вернуть поля таблицы. Повтор инструментов wrapper не выполняет; устойчивость должна определяться конкретной операцией.

| Инструмент | Контракт |
|---|---|
| list_tasks | [Чтение работ](tool-list-tasks.md) |
| update_task | [Изменение работы](tool-update-task.md) |
| get_schedule | [Занятия](tool-get-schedule.md) |
| propose_question | [Черновик вопроса](tool-propose-question.md) |
| propose_lesson_change | [Черновик переноса](tool-propose-lesson-change.md) |
| notify_owner | [Уведомление](tool-notify-owner.md) |
| list_telegram_chats | [Подключённые чаты](tool-list-telegram-chats.md) |
| add_telegram_chat | [Подключение](tool-add-telegram-chat.md) |
| read_chat_history | [История чата](tool-read-chat-history.md) |
| search_history | [Память Pi](tool-search-history.md) |
| read_hse | [Официальная страница](tool-read-hse.md) |

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| cancelled/deadline | OperationError | Из Core operation | Отмена/истёкший budget |
| dependency | exception | Из конкретного инструмента | См. отдельный контракт |
