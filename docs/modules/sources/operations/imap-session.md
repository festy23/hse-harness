# Защита IMAP соединения

## Метод

guardImapClient<T>(client:T) → T; assertImapHealthy(client) → void. client поддерживает on('error',listener) и close().

## Ресурсы

[WeakMap guarded](../caches.md), события соединения imapflow. Постоянного состояния нет.

## Алгоритм работы

1. guard при уже зарегистрированном client возвращает тот же объект без второго listener. Иначе создать state={}, поместить в WeakMap и зарегистрировать error listener; вернуть тот же client.
2. При событии error, если state.error уже truthy, завершить listener. Иначе сохранить error либо новый Error('IMAP connection failed'); вызвать close внутри try/catch, подавив исключение close.
3. assertImapHealthy проверяет guarded.get(client)?.error. При наличии бросить новый Error `Почтовое соединение прервано; чтение будет повторено`. При отсутствии вернуть void, включая незарегистрированный client.

## Результат и ошибки

Guard удерживает первый error и предотвращает необработанное событие error, в том числе после rejected connect. assert не заменяет проверки отмены. После socket error текущий MailSource poll обязан остановиться на следующей проверке здоровья; новая итерация создаёт новый экземпляр. Ошибка close внутри listener не выходит из него. Listener не удаляется при logout; сборка WeakMap записей следует GC клиента.
