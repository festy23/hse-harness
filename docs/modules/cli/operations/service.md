# Системная служба Linux

## Метод

serviceCLI(args), serviceUnit(options).

## Описание

Установить/управлять одной системной службой hse-harness.service.

## Ресурсы

systemctl, journalctl, sudo/install/rm, /etc/systemd/system/hse-harness.service, tmpdir, [runtime installation](../../runtime/operations/installation.md), [process runner](process.md).

## Входные параметры

serviceCLI принимает install [--dry-run], status, logs, stop, restart, uninstall. serviceUnit принимает `{node,executable,home,uid,gid,paths}`. uid safe integer>0; gid safe integer>=0; paths допускает только DOTENV_CONFIG_PATH/STUDY_CONFIG/STUDY_DATA_DIR/STUDY_SECRETS_DIR.

## Выходные параметры

serviceCLI — exit code дочерней команды либо0 для dry-run; serviceUnit — unit text.

## Результат в случае успеха

Install должен enable --now стабильный launcher. Uninstall должен удалить unit, сохраняя личный каталог.

## Результат в случае ошибки

Промежуточная ошибка systemctl/install должна вернуть её code, не продолжая последующие команды. Автоматический rollback уже установленного unit/runtime не выполняется.

## Алгоритм работы

1. Проверить action, args<=2, flag разрешён только install --dry-run; иначе INPUT. Требовать Linux, кроме dry-run. userInfo определяет root; systemctl вызывается напрямую для root, иначе sudo systemctl.
2. logs: runner journalctl либо sudo journalctl с `-u hse-harness.service -f`, вернуть code. status/stop/restart: systemctl(action,unit), code.
3. uninstall: systemctl disable --now; nonzero вернуть. Затем root rm либо sudo rm `-f /etc/systemd/system/hse-harness.service`; при0 daemon-reload, иначе вернуть error code.
4. install должен требовать HSE_HARNESS_HOME; взять четыре path env. dry-run должен только console.log(serviceUnit(node,current launcher path,home,user uid/gid,paths)), вернуть0; runtime не создавать.
5. Обычный install должен требовать managedInstallation(packageRoot), load SetupState, config.ownerId и TELEGRAM_BOT_TOKEN; runningPid должен отсутствовать. mkdir home0700; installRuntime; buildUnit с возвращённым launcher.
6. Создать tmpdir/hse-service-*, записать unit0600; runner `sudo install -m 644 <staging file> /etc/systemd/system/hse-harness.service`. При ненулевом code вернуть его. Затем daemon-reload; при0 enable --now; при0 вывести успех. В finally удалить staging recursive force.
7. serviceUnit должен отклонить CR/LF/NUL в home и всех quote values. Escape backslash/doublequote/%; executable дополнительно `$`→`$$`; quoted значения использовать для ExecStart и Environment. WorkingDirectory должен получить home с `%`→`%%`.
8. Unit должен содержать поля таблицы, в указанном section:

| Поле | Значение |
|---|---|
| Unit.Description | HSE HARNESS study assistant |
| Unit.After, Wants | network-online.target |
| Service.Type | simple |
| Service.User, Group | uid, gid |
| Service.WorkingDirectory | home |
| Service.ExecStart | quoted node + quoted executable |
| Service.Environment | NODE_ENV=production, HSE_HARNESS_HOME=home, четыре пути |
| Service.Restart, RestartSec | on-failure,10 |
| Service.KillMode, TimeoutStopSec | control-group,90 |
| Service.UMask | 0077 |
| Service.NoNewPrivileges, PrivateTmp | true,true |
| Install.WantedBy | multi-user.target |

Значения токенов/паролей в unit не включать. uid0 должен быть запрещён генератором unit даже для dry-run.

## Ошибки

| Код | Статус | Message | Описание |
|---|---|---|---|
| INPUT | SetupIssue | Использование… / Путь содержит… / Сервис принимает… | Аргументы и env whitelist |
| PLATFORM | SetupIssue | Системный сервис поддерживается на Linux… | Не-Linux без dry-run |
| USER | SetupIssue | …непривилегированного пользователя… | Невалидный uid/gid |
| INSTALL | SetupIssue | …постоянного сервиса… / Сначала подключи Telegram / …останови прежний экземпляр | Preconditions |
| PROCESS | integer nonzero/rejection | subordinate code | Частичный install/uninstall |
