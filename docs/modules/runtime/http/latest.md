# Обнаружение npm latest

## Метод

Внешний `GET https://registry.npmjs.org/%40ivan-boss%2Fhse-harness`.

## Описание

Получить доступную стабильную версию и SHA-512 identity для предложения владельцу.

## Ресурсы

fetch, [Core operations](../../core/settings.md), registry.

## Входные параметры

Путь должен быть константой PACKAGE_NAME. Дополнительные query/header/body отсутствуют. Внедряемый request должен по умолчанию равняться fetch; ctx — optional OperationContext.

## Выходные параметры

| Название | Тип | Обязательность | Описание |
|---|---|---|---|
| version | string | да | dist-tags.latest |
| integrity | string | да | versions[version].dist.integrity |

## Результат в случае успеха

HTTP 2xx и валидная identity должны возвращать два поля; tarball URL не входит в результат.

## Результат в случае ошибки

Ошибка должна передаваться caller; автоматического retry в методе нет.

## Алгоритм работы

1. withOperation('request',15000,ctx), GET с op.signal и redirect='error'. При !ok — REGISTRY.
2. response.text; при text.length>2000000 — SIZE. Ограничение применяется после чтения текста. parseRecord; получить dist-tags.latest; требовать stableVersion с пределом64 символа.
3. Прочитать versions[version] и dist; требовать name PACKAGE_NAME, pkg.version=version, integrity string matching `^sha512-[A-Za-z0-9+/]{86}==$`.
4. new URL(requiredString(dist.tarball)); требовать https, hostname registry.npmjs.org, пустые username/password/port. Вернуть version/integrity.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| REGISTRY | полученный не-2xx | Реестр npm временно недоступен | HTTP отказ |
| SIZE | локальный | Слишком большой ответ npm | >2000000 символов |
| DATA | локальный | latest не указывает… / метаданные некорректны / Архив обновления вне официального реестра | Поля/identity/URL |
| TRANSPORT | HTTP отсутствует | OperationError/fetch error | Сеть, deadline, отмена, redirect |
