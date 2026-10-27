# Настройки Assistant

| Название | Тип | Обязательность | Значение по умолчанию | Описание |
|---|---|---|---|---|
| config.model | string | Для открытия | Нет выбранной модели | Подписочная OpenAI model id; '' и choose-* запрещены |
| config.profile | StudyProfile | Нет | undefined | JSON данных владельца в system prompt |
| thinkingLevel | Константа string | Да | medium | Создание runtime сессии |
| compaction.enabled | boolean | Да | true | Штатная compaction |
| retry.enabled/maxRetries | boolean/integer | Да | true/2 | Retry SDK |
| noTools | string | Да | builtin | Отключить встроенные tools |
| model runtime budget | ms | Да | 120000 | Ограничен родительским ctx |
| model list timeout | ms | Да | 20000 | GET каталога подписки |
| tools executionMode | string | Да | sequential | Последовательные custom tools |
| default tool budget | ms | Да | 90000 | Все tools кроме трёх исключений |
| read_hse / read_chat_history / add_telegram_chat | ms | Да | 45000 / 45000 / 120000 | Отдельные budgets |
| search results / result length | integer | Да | 8 / 12000 chars | Последние совпадения JSON entries |

ResourceLoader должен возвращать только переданный system prompt; остальные ресурсы пустые, extendResources и reload — без действий. modelsPath должен быть null; ModelRuntime.allowModelNetwork=true, modelRefreshTimeoutMs=op.remainingMs(). Не разрешать API-key fallback вместо подписочного входа.
