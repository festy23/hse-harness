# Восстановление и контроль ответов

## Описание

Повтор подтверждённых sending действий и уведомление об отсутствии ответа на вопрос.

## Запуск

Каждые 10000 ms после завершения цикла параллельно `recover(ctx)` и `tick(now,ctx)`; общий budget 120000 ms. Входящий MTProto reply вызывает `reply(chat,replyTo)` отдельно.

## Входные параметры

recover: ctx?; tick: now epoch ms=Date.now(),ctx?; reply: chat:string,replyTo:string.

## Результат

void. Цикл должен выбрать первую fatal ошибку, иначе первую ошибку параллельных результатов. Ошибки отдельных recover не должны предотвращать запуск независимых действий той же порции.

## Ресурсы

[execute](../operations/decide-approval.md), approvals, delivered, Store, Bot.

## Алгоритм работы

1. recover должен выбрать все approvals со state=sending, в порядке массива. Обрабатывать последовательными порциями по 4, проверяя ctx abort до каждой.
2. Для порции вызвать execute(a,Date.now(),ctx) через Promise.allSettled. Fatal немедленно пробросить после завершения порции; первую нефатальную ошибку запомнить, продолжить следующие порции. В конце при наличии ошибки пробросить asError(first); иначе завершить. Возраст sending повторно не проверять.
3. reply должен найти первый kind=question,state=sent,payload.chat=chat,messageId=replyTo. При отсутствии завершить; иначе answered=true и Store.save. Содержание ответа и его полнота здесь не анализируются.
4. tick должен пройти approvals последовательно, проверяя ctx abort. Для question,state=sent,!answered, truthy sent, now-sent>=86400000 и !delivered[`no-answer:${id}`] вызвать bot.send с этим delivery id и текстом `На вопрос в чате ${chat} нет ответа сутки. Нужна твоя помощь.\n${text}`. После успеха delivered[key]=now, Store.save.
5. При ошибке tick прервать проход; непомеченная доставка должна остаться для следующего цикла. Поле answered не устанавливать по факту уведомления владельца.
