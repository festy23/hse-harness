# Координатор updates

## Метод

CommandCoordinator: observe(BotUpdate[]), advance(), idle(), check(), status().

## Ресурсы

[Кэши](../caches.md), [Store.botOffset](../database/README.md), Core.WorkerLifecycle, handle, isFast, onError, answerCallback?.

## Алгоритм работы

1. observe сначала вызывает check: при запомненной failure выбросить asError(failure). В порядке входного массива пропустить update_id < botOffset и уже присутствующие id; при entries.size >=100 прекратить добавление. Для остальных создать entry `{update,state:'waiting',retryAt:0,callback: callback_query&&answerCallback ? 'waiting':'done'}` и вызвать pump.
2. pump ничего не запускает, если lifecycle не accepting либо есть failure. Иначе пройти entries по возрастанию update_id: для callback waiting допустить до 4 параллельных lifecycle.run(answerCallback(id)); выставить running. В finally выставить done, уменьшить callbacks, удалить job и снова pump. Ошибку такого run сохранить в failure.
3. Затем пройти entries в том же порядке; пропустить не waiting и retryAt>Date.now(). Классифицировать isFast. При достигнутом соответствующем лимите продолжить обход. Увеличить fast/slow, установить running и захватить previous=tail.
4. В lifecycle.run медленная задача сначала ждёт previous; быстрая начинает без tail. Вызвать handle. При успехе state=done; при ошибке state=waiting, retryAt=Date.now()+retryMs, дождаться onError(error). Ошибку самого run/onError запомнить как failure. В finally уменьшить счётчик, удалить job, pump. Для медленной задачи присвоить tail этому job.
5. advance вызывает check, затем выбирает начальный префикс отсортированных entries, у которых state=done и callback=done. При пустом префиксе завершить void. Иначе установить botOffset=последний update_id+1 и дождаться Store.save. Только после save удалить выбранные entries и вызвать pump.
6. idle повторно ждёт Promise.all текущих jobs, пока Set не пуст, затем check. status возвращает observed=entries.size, fast/slow счётчики, waiting=число state=waiting.

## Результат и ошибки

Порядок медленных handle сериализован; быстрые могут завершаться раньше них. Offset продвигать только за завершённый префикс наблюдаемых updates; gaps в номерах не заполнять. Retry waiting не имеет собственного таймера: новый pump возникает от observe/advance/завершения jobs. Ошибку save передать вызывающему, entries до успешного save не удалять. Перезапуск утрачивает entries, но сохранённый offset и ownerUpdates/outbox остаются.
