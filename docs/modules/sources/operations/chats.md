# Разрешение и добавление Telegram источника

## Метод

parseTelegramChatReference(input) → `{kind:'id'|'username'|'invite',value:string}`; resolveTelegramChat(client,reference,ctx?) → `{chat,peer}`; TelegramSource.addChat(reference,ctx?); listChats().

## Ресурсы

[Dialogs/history](telegram-pages.md), [RPC](telegram-rpc.md), config файл и [Core locking](../../core/operations/locking.md), peers, history cursors.

## Алгоритм нормализации ссылки

1. trim input; пустой либо length>500 отвергнуть ошибкой `Укажи ID группы/канала, @username или ссылку t.me на чат либо сообщение`.
2. Если `/^-?\d{1,20}$/` и BigInt!=0, вернуть id со String(BigInt). Иначе удалить начальный @ и проверить username `/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/`; при совпадении вернуть lowercase username.
3. Для начала t.me/ или telegram.me/ без схемы добавить https://; разобрать URL, отвергнуть username/password/port.
4. Для tg: разрешить только host resolve с валидным query domain username либо join с query invite `/^[a-zA-Z0-9_-]{1,200}$/`; вернуть lowercase username либо неизменный invite. Иное отвергнуть.
5. Для остальных разрешить только https: и hostname t.me/telegram.me. Удалить один завершающий slash path. `/c/<1..16 digits>/<digits>[/<digits>]` при положительном channel id вернуть каноническим PeerChannel ID.
6. `/<+ либо joinchat/><invite>` вернуть invite. `/(s/)?<username>(/<digits>(/<digits>)?)?` вернуть lowercase username, кроме joinchat/share/addstickers/proxy/socks/login. Иное отвергнуть. Неиспользуемые query/hash HTTPS не влияют на результат.

## Алгоритм разрешения

1. Создать tool operation addChat=120000; нормализовать reference и прочитать все dialogs. members — Chat с !left,!deactivated,!migratedTo либо Channel с !left.
2. Для id выбрать members, где canonical getPeerId==value либо положительное значение совпадает с raw entity.id. Для username сначала искать Channel.username либо active usernames без учёта регистра. При отсутствии вызвать contacts.ResolveUsername({username:value}) и найти result.peer в chats/users; любая ошибка этого запроса заменяется `Telegram-чат по этой ссылке не найден; проверь ссылку или передай ID`.
3. Для invite вызвать messages.CheckChatInvite({hash:value}); отмену и OperationError передать, прочие ошибки заменить сообщением о недействительной ссылке. При результате не ChatInviteAlready завершить ошибкой отсутствия доступа; автоматического join/import invite не выполнять.
4. Для username/invite потребовать Chat/Channel, иначе `Источник должен быть группой или каналом, а не личным диалогом`. Выбрать совпадающий canonical ID только из members.
5. Дедуплицировать matches по canonical ID. При >1 завершить `Неоднозначный ID: передай полный Telegram ID с префиксом -100 либо ссылку`. При пустом matches завершить `Нет доступа к этому чату: личный Telegram-аккаунт должен уже состоять в нём. Автоматическое вступление отключено`.
6. peer=getInputPeer(entity); запросить историю offset=0 limit=1. Отмену и OperationError передать; прочие ошибки заменить `Не удалось прочитать чат. Проверь доступ личного Telegram-аккаунта и повтори попытку`. Вернуть chat={id:getPeerId(entity),title:entity.title,allowQuestions:false}, peer.

## Алгоритм addChat и listChats

1. addChat создаёт tool operation 120000, выполняет connect и resolveTelegramChat. alreadyAdded вычислить по текущему config.chats до записи файла.
2. Под config write lock перечитать файл. Требовать raw.ownerId===config.ownerId, иначе ошибка о смене владельца. Требовать массив chats с object/string id/title. Найденный chat.id вернуть без записи; иначе дописать новый chat и writeSecret(JSON.stringify(raw,null,2)+'\n'). Неперечисленные поля raw сохранять. Lock ждать до 5000 ms с шагом 25 ms для известных busy ошибок, другие пробрасывать; release в finally.
3. Только после успеха записи заменить/добавить saved chat в config.chats, peers.set(saved.id,peer). Вернуть поля saved и allowQuestions=saved.allowQuestions!==false, alreadyAdded, historyFrom=HISTORY_FROM, backfillPending=!cursors[tgHistory:saved.id].
4. listChats не выполняет сеть: вернуть config.chats в исходном порядке с полями chat, allowQuestions!==false, connected=Boolean(client&&client.connected!==false&&peers.has(id)), historyLoaded=Boolean(cursors[tgHistory:id]).

## Ошибки и фиксация

Ошибки parse/access/protocol/operation/file/lock завершают Promise. До успешной durable config записи новый chat не активировать в памяти. Чат, добавленный во время pollSlice, попадёт в snapshot peers следующей итерации. Existing allowQuestions не переопределять значением false из resolve. Ошибки таблиц RPC и страниц передавать, кроме явно указанных замен.
