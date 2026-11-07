# Выбор и загрузка текста письма

## Метод

textPart(bodyStructure?) → MessageStructureObject|undefined; readText(client,m,messageCtx) → string.

## Ресурсы

MIME bodyStructure, IMAP download, STUDY_MAX_TEXT_BYTES, [Core compute](../../core/README.md), OperationContext.

## Алгоритм textPart

1. stack=[node] при наличии node, иначе []; html=undefined,count=0. Пока stack непуст, pop последний part и увеличить count. При count>10000 завершить payload-limit `Слишком сложная структура письма`.
2. Если disposition.toLowerCase()='attachment' либо truthy dispositionParameters.filename либо parameters.name либо type='message/rfc822', пропустить узел со всеми потомками.
3. Если type='text/plain', немедленно вернуть part. Если type='text/html', запомнить его только если html ещё отсутствует и продолжить без обхода его потомков.
4. Для остальных узлов положить childNodes в stack в обратном порядке индексов, обеспечивая обход исходного порядка. После опустошения stack вернуть первый найденный html либо undefined.

## Алгоритм readText

1. part=textPart(m.bodyStructure); при undefined вернуть ''. Иначе maxBytes=Number(env STUDY_MAX_TEXT_BYTES??2000000); потребовать safe integer и >=6000, иначе Error `Некорректный STUDY_MAX_TEXT_BYTES`.
2. Выполнить client.download(String(m.uid),part.part||'1',{uid:true,maxBytes}). Вызов ограничен request context родителя, его abort закрывает соединение. Если content отсутствует, завершить `Текстовая часть письма не получена; не считать письмо обработанным`.
3. Для каждого chunk async stream проверить message.throwIfAborted; разрешить string или Uint8Array, иначе OperationError protocol `Некорректный фрагмент письма`. Преобразовать Buffer.from(chunk), прибавить byteLength. При bytes>maxBytes завершить payload-limit `Письмо превышает допустимый размер`; иначе append buffer.
4. После окончания потока при bytes>=maxBytes завершить Error `Письмо превышает STUDY_MAX_TEXT_BYTES; не считать его полностью обработанным`. Равенство лимиту также считается неполной загрузкой.
5. Объединить buffers, декодировать UTF-8. Для text/html выполнить runCompute({type:'html',mode:'mail',html:text,maxBytes},message) и вернуть result.text; иначе вернуть text. Дополнительного charset преобразования здесь нет.

## Ошибки

| Код | Message | Результат |
|---|---|---|
| payload-limit | Слишком сложная структура / превышен размер | Не возвращать частичный текст |
| protocol | Некорректный фрагмент | Прекратить загрузку |
| config/download/compute | Ошибки соответствующего шага | Отклонить Promise; pollMessage не продвигает cursor |
| deadline/cancelled | reason контекста | Закрытие IMAP и повтор в следующем poll |
