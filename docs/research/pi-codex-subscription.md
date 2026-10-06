# Pi на VPS с существующей подпиской ChatGPT/Codex

Проверено 4 октября 2026 года. Прочитаны OpenAI Docs по подписочной авторизации, официальный маршрут Sign in with ChatGPT и исходники Pi. Реальные логины, запросы к модели и настройки аккаунта не выполнялись; секреты не читались. Исходники локального снимка Pi: commit `4c6fb7cfe8c538a668726f6f8b3554098c39faee`; ключевые файлы дополнительно открыты в текущем официальном GitHub.

Позднее пользователь уточнил тариф как «Pro x20» OpenAI. Ниже утверждения «тариф неизвестен» описывают состояние на момент исходной проверки. Доступность конкретного маршрута/модели и программных данных о лимите для его аккаунта по-прежнему не проверена.

## Подтвержденное

**Обычный Pi coding agent технически поддерживает использование ChatGPT-подписки.** Сейчас есть два разных маршрута:

| Маршрут | Реализация | Вход на VPS |
|---|---|---|
| `/login openai` → Sign in with ChatGPT | Новый OAuth-маршрут `chatgpt.tokens.use.direct`, публичный Responses API `https://api.openai.com/v1` | Браузерная авторизация с callback и вставкой полного redirect URL; собственного device-code выбора в этом модуле нет |
| `/login openai-codex` | Старый ChatGPT/Codex OAuth, `https://chatgpt.com/backend-api`; провайдер теперь называется legacy | Browser login либо Device code login (headless), также обновление OAuth-токенов |

Новый подписочный вход добавлен в Pi 0.99.0 от 29 сентября 2026 года; changelog явно сообщает, что он заменяет legacy Codex-провайдер. Это поддержка в обычном Pi, независимая от Pi Durable. [Pi coding-agent changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md), [Pi AI changelog](https://github.com/earendil-works/pi/blob/main/packages/ai/CHANGELOG.md), [новый OAuth](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-chatgpt.ts), [legacy OAuth](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-codex.ts), [legacy provider](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/openai-codex.ts).

OpenAI официально документирует подписочный доступ для open-source приложений через Sign in with ChatGPT и отдельную процедуру для self-hosted VM. Это разрешение на подходящие запросы Responses API, без доступа к истории ChatGPT или другим сведениям из аккаунта. У приложения/хоста своя идентификация; учетные данные и host ID — разные вещи. Поэтому утверждение «подпиской можно пользоваться только в официальном Codex» уже не соответствует текущей документации. [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source).

Документация VM предлагает завершить OAuth локально тем же клиентом, защищенно перенести его учетные данные на VM, сохранить отдельный стабильный ID VM и передать ей дальнейшее обновление токенов. Реализация Pi также позволяет начать browser login на VPS и вставить полный callback URL, если автоматический callback не дошел. Это технически поддержанный Pi вариант; его работоспособность для данного аккаунта еще не проверена. [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms), [Pi providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md).

Официальный **Codex CLI** отдельно поддерживает ChatGPT-подписку и `codex login --device-auth` (beta) для headless-среды. Эту команду нельзя выдавать за команду Pi или обещать, что Codex `auth.json` напрямую подходит Pi. Это разные клиенты и форматы хранилища. [Codex authentication](https://learn.chatgpt.com/docs/auth).

## Лимиты и функции

Подписочный доступ и API-ключ — разные способы оплаты. Бюджет API не нужен для использования принятого OAuth-гранта подписки; ошибка подписочного маршрута не переводит запрос автоматически на другой способ оплаты. Возможны ограничения аккаунта, рабочей области, региона, приложения и доступности маршрута. При исчерпании лимита нужно приостанавливать новые запросы и показывать состояние пользователю; код ошибки сам по себе не дает времени сброса. [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

Лимит Plus за пять часов общий для приложений, использующих этот план, включая частные и open-source клиенты. У Pro этот конкретный лимит отсутствует; из этого не следует отсутствие других ограничений. Использование учебного агента может уменьшать ресурс для собственных задач пользователя. Также есть настройка доли/лимита приложения и разрешения использовать кредиты. [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [Pricing](https://learn.chatgpt.com/docs/pricing).

Для нового SIWC маршрута нужно использовать публичный Responses API, `store: false`, `stream: true` и хранить/передавать нужный контекст на стороне приложения. Старые `backend-api` endpoints не являются документированным endpoint этого нового маршрута. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

У SIWC сейчас ограничения возможностей: function/custom tools поддерживаются, но hosted file search, Code Interpreter, hosted MCP/connectors и ряд параметров Responses не поддерживаются. Локальные инструменты учебного агента нужно реализовывать на стороне Pi/приложения; не предполагать доступ ко всем сервисным возможностям OpenAI API через подписку. [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Вывод для спецификации — предложение

Для выбранного обычного Pi на VPS предварительно использовать современный `/login openai` с подпиской через SIWC. Legacy `openai-codex` существует, но не должен становиться выбором по старым инструкциям без причины. Наличие OAuth-провайдера в коде не подтверждает entitlement конкретного пользователя или пригодность конкретной модели.

До реализации остаются вопросы: версия Pi, тип подписки/рабочей области, модель из доступного аккаунту каталога, допустимая доля общего лимита для фонового агента и поведение при недоступности модели. Подтверждение на практике — успешная авторизация и завершенный минимальный запрос, выполненные позднее в рамках настройки; сейчас это не сделано.

Рекомендуемое поведение при исчерпании подписочного лимита: сохранять входящие сообщения в очередь, продолжать отправлять напоминания об уже сохраненных обязательствах без LLM, явно сообщать о задержке анализа. Платный fallback через API пока не выбран.

## Наблюдаемость лимита и предупреждение заранее

Дополнительно проверено 4 октября 2026 года. Пользователь хочет Telegram-предупреждение о приближении лимита; тариф пока неизвестен.

В проверенных SIWC docs **не найден документированный endpoint или контракт response headers, сообщающий достоверные остаток, процент и время сброса подписочного лимита**. Документация направляет пользователя в ChatGPT Settings → Usage и описывает ошибку уже достигнутого лимита. Из `subscription_sharing_usage_limit_exceeded` нельзя выводить время сброса или считать весь план исчерпанным: лимит бывает специфичен для приложения. Это отсутствие подтвержденного контракта, а не доказательство отсутствия такой возможности. [Tracking usage](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#tracking-usage), [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

Обычный Pi показывает статистику **сессии**: токены, расчетную стоимость и заполнение контекстного окна (`/session`, RPC `get_session_stats`). В проверенном списке встроенных команд `/usage` нет; готового счетчика остатка ChatGPT-плана в стандартных исходниках не найдено. Эти показатели не заменяют общую квоту аккаунта. [Slash commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/slash-commands.ts), [RPC session stats](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md#get_session_stats).

Pi передает HTTP status и headers через `onResponse`; это позволяет позднее исследовать реальные ответы без изменения провайдера. Но само наличие callback не подтверждает, что SIWC возвращает оставшуюся подписочную квоту. Общие `x-ratelimit-remaining-*`/`x-ratelimit-reset-*` документированы для API rate limits, а не как остаток ChatGPT-плана. [Pi Responses provider](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-responses.ts), [OpenAI API rate limits](https://developers.openai.com/api/docs/guides/rate-limits#rate-limits-in-headers).

Следствие для реализации: заблаговременное предупреждение остается требованием с непроверенным источником данных. Нельзя обещать точное «осталось 10%» на основе токенов нашей сессии. При настройке потребуется проверить доступность реального показателя; если его нет, честно обозначить недоступность предварительного предупреждения и уведомлять о подтвержденном достижении лимита. Вход, inference и приватные endpoints в этой проверке не использовались.
