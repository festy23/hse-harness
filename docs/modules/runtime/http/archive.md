# Загрузка архива npm

## Метод

Внешний `GET <metadata.dist.tarball>`.

## Описание

Загрузить ресурс для изолированной подготовки выпуска.

## Ресурсы

ReleaseStore.fetch, registry, timeout, [releases](../operations/releases.md).

## Входные параметры

URL — проверенный dist.tarball; header accept=`application/json, application/octet-stream`.

## Выходные параметры

Выход — Buffer всего тела. SHA-512, tar boundaries и файловая проверка должны выполняться до npm согласно [prepare](../operations/releases.md).

## Результат в случае успеха

При HTTP 2xx и выполненных ограничениях вернуть ресурс. Redirect запрещён.

## Результат в случае ошибки

Бросить Error; повторов в boundedFetch нет; preparation caller управляет backoff.

## Алгоритм работы

1. Проверить внешний signal. Создать AbortSignal.timeout(timeout=180000 по умолчанию), объединить с внешним через AbortSignal.any.
2. fetch с signal, redirect='error' и указанным header. При !response.ok — HTTP. Числовой content-length>64 MiB — SIZE.
3. Читать response.body чанками, проверяя combined signal и суммарные bytes. При bytes>64 MiB попытаться cancel body, игнорируя ошибку cancel, и завершить SIZE. На точной границе принять.
4. Buffer.concat chunks; для version выполнить проверки из раздела выхода; ошибка JSON/identity — DATA. Для archive вернуть Buffer.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| HTTP | полученный не-2xx | release registry HTTP <status> | Реестр отклонил |
| SIZE | локальная ошибка | release download exceeds size limit | Заголовок либо фактический поток |
| DATA | локальная ошибка | metadata/SRI/tarball/JSON error | Неприемлемый ответ |
| TRANSPORT | HTTP отсутствует | fetch/abort/timeout error | Отмена, сеть, redirect |
