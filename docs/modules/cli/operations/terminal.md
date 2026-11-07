# Терминальный интерфейс

## Метод

terminal SetupUI, unwrap, withProgress, welcome/showReport/step/success/failure/finish, brand/showBrand, icons/modelMark/messengerMark/providerLabel, SetupIssue/SetupCancelled/setupError.

## Описание

Предоставить ввод, выбор, отмену и отображение состояния без вывода secret values.

## Ресурсы

@clack/prompts, stdout/stdin, signal handlers, env TERM/NO_COLOR/FORCE_COLOR, [report](status.md).

## Входные параметры

InputRequest `{message,initial?,secret?,optional?,validate?,signal?}`; Choice arrays; selected IDs; yes initial; task message/action; brand `{columns,colorDepth}`; output WriteStream default stdout.

## Выходные параметры

input — trim string; choose — выбранный id; many — IDs; yes — boolean; task — значение action; brand — string. Остальные render методы — void.

## Результат в случае успеха

Ввод должен валидироваться до возвращения. Progress должен снимать обработчики/таймеры и восстанавливать cursor в finally.

## Результат в случае ошибки

Clack cancel-symbol должен вызывать SetupCancelled('Настройка отменена'). setupError должен выводить message только для SetupIssue; прочая ошибка — фиксированное безопасное сообщение о незавершённом шаге и прежних настройках.

## Алгоритм работы

1. Установить русские SELECT/MULTISELECT instructions и cancel/error messages. input должен p.password для secret и p.text иначе; initial default ''. Проверка: отсутствие value.trim при !optional→'Заполни поле'; иначе validate(trim??''). Возвратить trim unwrap result.
2. choose должен передать options value=id/label/hint; initial передать только если id есть в choices. many при пустом списке выводит сообщение и []; иначе autocompleteMultiselect с required=false, maxItems=8, initialValues=пересечение selected с choices; maxItems задаёт высоту отображения, не лимит числа источников. yes использует confirm(initial=true по умолчанию, Да/Нет).
3. task=withProgress: создать AbortController; animation только stdout.isTTY && TERM!='dumb'; title заменить CR/LF на пробел и убрать хвостовые точки/ellipsis. Повесить SIGINT/SIGTERM: один abort SetupCancelled, остановить анимацию, вывести отмену.
4. Для animation скрыть cursor, перерисовывать строку каждые100 ms frames ◒◐◓◑; учитывать columns=max(8,columns||80), обрезать по Unicode code points до columns-2 плюс ellipsis при length>=columns. Без animation каждая paint должна писать новую строку.
5. Await action(signal); если signal aborted после результата — SetupCancelled. Сохранить success/error/cancelled. В finally clear interval, снять handlers, вывести итог ✓/○, восстановить cursor и newline при animation.
6. showReport должен выводить ready icon/title/detail (внутренние LF заменить ' · '), running PID либо stopped, имя при наличии и completed/total. welcome должен showBrand и intro. success добавляет saved icon; finish вызывает cancel либо outro по аргументу.
7. showBrand должен ничего не выводить вне TTY либо TERM=dumb. depth=1 при NO_COLOR существует либо FORCE_COLOR='0', иначе getColorDepth; columns fallback80. brand при columns<40 должен вернуть две строки HSE HARNESS/ВЫСШАЯ ШКОЛА ЭКОНОМИКИ;40..75 — эмблема18 и компактная подпись;>=76 — эмблема28, bitmap HSE/HARNESS и подпись. Margin2 при columns>=48.
8. Bitmap должен использовать встроенные font/monogram из [brand.ts](../../../../src/cli/brand.ts), соединять по две pixel rows glyph █/▀/▄; depth<4 — monochrome █/░; depth>=24 — RGB white245,248,255, blue emblem19,44,101/letter86,155,255; depth>=8 — palette255/18/75; иначе ANSI97/94 foreground и107/44 background.
9. modelMark должен lower-case provider: openai/openai-codex/codex→`>_ Codex`, anthropic/claude→`✳️ Claude`, deepseek→`🐋 DeepSeek`, fallback `🤖 AI`. messengerMark telegram→`✈️ Telegram`, yandex→`💬 Яндекс Мессенджер`, fallback `💬 <provider>`. providerLabel должен соединять icon/name пробелом. Общие icons должны соответствовать [icons.ts](../../../../src/cli/icons.ts).

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| CANCEL | SetupCancelled | Настройка отменена | UI cancel или task signal |
| ACTION | rejected Promise | action error | task должен сохранить исходную ошибку, если не отменён |
