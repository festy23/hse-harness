# Метаданные точной npm-версии

## Метод

Внешний `GET <registry>/<encodeURIComponent(PACKAGE_NAME)>/<version>`.

## Описание

Загрузить ресурс для изолированной подготовки выпуска.

## Ресурсы

ReleaseStore.fetch, registry, timeout, [releases](../operations/releases.md).

## Входные параметры

version — стабильная semver path; registry из настроек; header accept=`application/json, application/octet-stream`.

## Выходные параметры

JSON name должен быть PACKAGE_NAME, version — запрошенная, engines.node — строго >=22.19.0. dist.integrity должен соответствовать SHA-512 SRI regex, декодироваться в64 байта и обратно в ту же base64 строку. dist.tarball должен иметь тот же origin, что registry, без username/password. Выход — проверенные integrity и tarball URL для prepare.

## Результат в случае успеха

При HTTP 2xx и выполненных ограничениях вернуть ресурс. Redirect запрещён.

## Результат в случае ошибки

Бросить Error; повторов в boundedFetch нет; preparation caller управляет backoff.

## Алгоритм работы

1. Проверить внешний signal. Создать AbortSignal.timeout(timeout=180000 по умолчанию), объединить с внешним через AbortSignal.any.
2. fetch с signal, redirect='error' и указанным header. При !response.ok — HTTP. Числовой content-length>1 MiB — SIZE.
3. Читать response.body чанками, проверяя combined signal и суммарные bytes. При bytes>1 MiB попытаться cancel body, игнорируя ошибку cancel, и завершить SIZE. На точной границе принять.
4. Buffer.concat chunks; для version выполнить проверки из раздела выхода; ошибка JSON/identity — DATA. Для archive вернуть Buffer.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| HTTP | полученный не-2xx | release registry HTTP <status> | Реестр отклонил |
| SIZE | локальная ошибка | release download exceeds size limit | Заголовок либо фактический поток |
| DATA | локальная ошибка | metadata/SRI/tarball/JSON error | Неприемлемый ответ |
| TRANSPORT | HTTP отсутствует | fetch/abort/timeout error | Отмена, сеть, redirect |
