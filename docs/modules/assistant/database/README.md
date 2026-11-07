# Ресурсы Assistant

| Ресурс | Форма | Владелец записи |
|---|---|---|
| `state.sessionPath` | Путь штатного файла SessionManager | PiAssistant.open через Store.save |
| `${dataDir()}/sessions` | Штатные session JSONL Pi SDK | SessionManager append API |
| `${secretsDir()}/pi-auth.json` | Штатный auth Pi SDK | ModelRuntime/login |
| `${dataDir()}/models.json` | Штатный каталог ModelRuntime | ModelRuntime |
| `${dataDir()}/pi` | Настройки Pi login, постоянный deviceId | SettingsManager.create/flush |
| queue.phase/answer | prompting/answer и строка результата | [Agent loop](../jobs/agent-turn.md) через [Core Store](../../core/database/README.md) |

Не создавать альтернативную память, отдельную БД, PostgreSQL/Redis. Штатная история и compaction должны хранить учебный контекст. search_history должен читать исходные записи SessionManager, включая записи до compaction, а не только текущий prompt-контекст.

| custom entry | Поля data | Момент записи |
|---|---|---|
| hse-operation-start | `{turnId:string}` | До session.prompt |
| hse-operation-result | `{turnId:string,answer:string}` | После успешного prompt, до checkpoint |
| hse-operation-result при восстановлении | `{turnId:string,answer:string,recovered:true}` | После подтверждения завершённого assistant message |
| custom message study-reference | String справочных данных, display=false | Начальная загрузка legacy профиля в пустую сессию |

Нельзя считать сохранённый ответ пригодным к подтверждению queue до успешного checkpoint в обычном prompt. Ошибка append/fsync должна становиться sticky durability, не исчезающей после следующего успешного чтения.
