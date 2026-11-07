# Оценка памяти Pi

## Контракт

`npm run eval` выполняет встроенную проверку сохранения фактов после compaction и повторного открытия сессии. Вход: обязательный STUDY_EVAL_MODEL и действующая подписка OpenAI. Выход: PASS в stdout либо ошибка и exitCode=1. Это ограниченная проверка памяти, без доказательства полноты извлечения учебных данных.

## Ресурсы

[Pi runtime](../../assistant/README.md), авторизация и каталоги из [Core](../../core/settings.md), временный каталог `study-eval-*` в os.tmpdir, SessionManager JSONL, модель OpenAI.

## Алгоритм работы

1. Создать прикладные directories. При отсутствующем STUDY_EVAL_MODEL завершиться ошибкой обязательной модели. Получить modelRuntime; потребовать isUsingSubscription('openai') и существование getModel('openai', id); иначе вернуть соответствующую ошибку.
2. Создать временный каталог и SessionManager. Создать AgentSession с cwd=temp, выбранной моделью/runtime, resourceLoader(instructions), noTools='builtin', tools=[], SettingsManager.inMemory с compaction.enabled=true и keepRecentTokens=1. При ошибке создания до try временный каталог может остаться.
3. Передать фиксированные контрольные факты: A по Тестированию сначала до 20.10.2026 15:00 +03:00, перенесена на 23.10 18:00, сделана и не сдана; B по НИС до 25.10 без часа; C отменена. Запросить только подтверждение. Последнее сообщение должно иметь role=assistant и stopReason отличный от error/aborted; иначе завершиться ошибкой.
4. Выполнить compact с требованием сохранить актуальные задания, переносы, источники, статусы и правило даты без времени. Dispose исходную сессию.
5. Открыть SessionManager по сохранённому sessionFile и создать новую AgentSession с теми же cwd/runtime/model/instructions и без tools. Запросить JSON по A.deadline/status, B.deadline, C.status. Проверить завершённый assistant ответ как в шаге 3.
6. Из getLastAssistantText выделить жадное совпадение от первого `{` до последнего `}`. Отсутствие совпадения — ошибка. ParseRecord и record для A/B/C; requiredString для deadlines. Потребовать A.deadline=моменту `2026-10-23T18:00:00+03:00`, A.status=done, B.deadline=моменту `2026-10-25T00:00:00+03:00`, C.status=cancelled. Иначе завершиться ошибкой потери факта.
7. При успехе вывести PASS с указанием ограниченности контроля. В finally dispose resumed session, затем исходную session и удалить временный каталог recursive/force.

## Ошибки и внешние действия

Вызовы prompt/compact используют модель и подписку; дополнительных timeout/retry этот скрипт не задаёт. Tools пусты: отправок Telegram и правок календаря нет. Ошибка авторизации, каталога, ответа, JSON, несовпадения фактов или filesystem печатается в stderr с exitCode=1. Удаление временной сессии не отменяет уже выполненных модельных запросов.

Источник: [evaluate.ts](../../../../src/evaluate.ts).
