import { SetupCancelled, SetupIssue, setupError } from './errors.js';
import { SetupState } from './state.js';
import { Onboarding, sections } from './onboarding.js';
import { connections } from './connections/index.js';
import { ServiceControl } from './service.js';
import { setupReport } from './status.js';
import * as rendering from './terminal.js';
import type { SetupConnections, SetupUI, SetupSection } from './ports.js';
import { icons } from './icons.js';
import { showTelegramAccess } from './telegram-access.js';
import { formatRuntimeStatus, installedRuntimeStatus, updatesCLI } from './updates.js';

const help = `HSE HARNESS

hse-harness                    интерактивное меню
hse-harness setup              настройка всех разделов
hse-harness profile            курс, группа, предметы
hse-harness telegram           бот и учебные чаты
hse-harness telegram-chats     разрешённые чаты и правила доступа
hse-harness mail               Яндекс Почта и папки
hse-harness model              подписка ChatGPT и модель
hse-harness calendars          расписание и дедлайны
hse-harness status             сохранённые настройки
hse-harness start              запуск бота в текущем терминале
hse-harness run                прямой запуск без supervisor и подхвата обновлений
hse-harness updates status     установленная и работающая версии, этап обновления
hse-harness updates enable     включить применение установленных npm-обновлений
hse-harness updates disable    оставить текущую версию, выключить применение
hse-harness updates retry      повторить подготовку ожидающей версии
hse-harness updates rollback   откат к проверенному предыдущему выпуску
hse-harness paths              расположение личных данных
hse-harness import /путь        перенос старой установки в пустой каталог
hse-harness service install    автозапуск на Linux через systemd
hse-harness service status     состояние сервиса
hse-harness service logs       логи сервиса
hse-harness service stop       остановка сервиса
hse-harness service restart    перезапуск сервиса
hse-harness service uninstall  удалить сервис, сохранив личные данные
hse-harness --version          версия установленного npm-пакета

↑ ↓ — выбрать · Enter — подтвердить · Ctrl+C — отменить
Google / Яндекс / iCloud Calendar
Постоянный npm start/service: автоматическое применение после npm update -g.
Первый переход с 0.1.0 требует одной остановки и установки supervisor.
Supervisor проверяет отдельную установку; он не знает код выхода чужого npm update.
npx, исходники и прямой run не наблюдают глобальные обновления.
Из исходников: npm run harness -- <команда>; настройка: npm run harness -- configure`;

type View = Pick<
  typeof rendering,
  'welcome' | 'showReport' | 'step' | 'success' | 'failure' | 'finish'
>;
export interface CLIDependencies {
  state: SetupState;
  ui: SetupUI;
  connections: SetupConnections;
  service: ServiceControl;
  view: View;
  interactive: boolean;
  print: (message: string) => void;
}

export async function runCLI(
  args: string[] = [],
  overrides: Partial<CLIDependencies> = {},
): Promise<number> {
  const print = overrides.print ?? console.log;
  const command = args[0];
  if (command === 'help' || command === '--help' || command === '-h') {
    print(help);
    return 0;
  }
  if (command === 'updates') {
    return updatesCLI(args.slice(1), { print });
  }
  const valid = [
    'start',
    'status',
    'telegram-chats',
    'configure',
    ...sections.map((section) => section.id),
  ];
  if (args.length > 1 || (command && !valid.includes(command))) {
    throw new SetupIssue('Неизвестная команда. Справка: hse-harness help');
  }
  const state = overrides.state ?? new SetupState();
  await state.load();
  const ui = overrides.ui ?? rendering.terminal;
  const service = overrides.service ?? new ServiceControl(state.root);
  const view = overrides.view ?? rendering;
  const report = async () => setupReport(state, await service.pid());
  const showUpdates = async () => {
    if (process.env.HSE_HARNESS_HOME) {
      ui.note(formatRuntimeStatus(await installedRuntimeStatus()), 'Версии и обновления');
    } else {
      ui.note(
        'Запуск из исходников: автоматическое применение глобальных npm-обновлений не включено.',
      );
    }
  };
  const start = async (): Promise<number | undefined> => {
    const result = await service.start(state.config, (message) => ui.note(message));
    if (result.kind === 'already-running') {
      ui.note(
        `Бот уже работает · PID ${result.pid}\nПроверь соединения командой /status в личном чате.`,
      );
      return;
    }
    if (result.code && result.code !== 130 && result.code !== 143) {
      view.failure(`Бот завершился с кодом ${result.code}. Проверь сообщения запуска выше.`);
    }
    return result.code;
  };
  if (command === 'start') {
    return (await start()) ?? 0;
  }
  if (command === 'status') {
    view.showReport(await report());
    await showUpdates();
    ui.note(
      'Показаны сохранённые данные. Реальные соединения проверяются командой /status в боте.',
    );
    return 0;
  }
  if (command === 'telegram-chats') {
    showTelegramAccess(state.config, ui);
    return 0;
  }
  if (!(overrides.interactive ?? process.stdin.isTTY)) {
    throw new SetupIssue(
      'Открой интерактивный терминал и выполни hse-harness (из исходников: npm run harness). Справка: hse-harness help',
    );
  }

  const flow = new Onboarding(state, ui, overrides.connections ?? connections);
  const runSection = async (id: SetupSection) => {
    await state.prepare();
    await flow.run(id);
    view.success(`${sections.find((section) => section.id === id)!.title} — сохранено`);
  };
  const configure = async (): Promise<'done' | 'menu'> => {
    try {
      for (const [index, section] of sections.entries()) {
        view.step(`Шаг ${index + 1}/${sections.length} · ${section.title}`);
        const row = (await report()).rows.find((item) => item.id === section.id)!;
        const action = await ui.choose(
          'Продолжить настройку',
          [
            { id: 'edit', label: row.ready ? 'Изменить настройки раздела' : 'Настроить раздел' },
            {
              id: 'skip',
              label: row.ready ? 'Оставить сохранённые настройки' : 'Пропустить и настроить позже',
            },
            { id: 'menu', label: 'Вернуться в меню' },
          ],
          row.ready ? 'skip' : 'edit',
        );
        if (action === 'menu') {
          return 'menu';
        }
        if (action === 'edit') {
          await runSection(section.id);
        }
      }
    } catch (error) {
      if (!(error instanceof SetupCancelled)) {
        throw error;
      }
      ui.note('Раздел отменён. Прежние настройки сохранены; можно выбрать другой пункт.');
      return 'menu';
    }
    view.showReport(await report());
    return 'done';
  };

  view.welcome();
  let current = await report();
  view.showReport(current);
  if (current.pid) {
    ui.note('Изменения профиля, источников и календарей применятся после перезапуска бота.');
  }
  try {
    if (command) {
      const outcome =
        command === 'configure'
          ? await configure()
          : (await runSection(command as SetupSection), 'done');
      if (outcome === 'done') {
        view.finish(
          'Настройки сохранены. Запуск: hse-harness start (из исходников: npm run harness -- start)',
        );
        return 0;
      }
    }
    while (true) {
      current = await report();
      const action = await ui.choose(
        'Главное меню',
        [
          {
            id: 'configure',
            label: `${icons.configure} Настроить всё по шагам`,
            hint: `${current.completed}/${current.total} разделов заполнено`,
          },
          {
            id: 'start',
            label: `${icons.start} ${current.pid ? 'Проверить работающего бота' : 'Запустить бота'}`,
            hint: 'запуск учебного помощника',
          },
          ...sections.flatMap((section) => [
            {
              id: section.id,
              label: section.title,
              hint: current.rows.find((row) => row.id === section.id)!.ready
                ? `${icons.saved} сохранено`
                : `${icons.missing} нужно настроить`,
            },
            ...(section.id === 'telegram'
              ? [
                  {
                    id: 'telegram-chats',
                    label: `${icons.status} Разрешённые Telegram-чаты`,
                    hint: `${state.config.chats.length} источников`,
                  },
                ]
              : []),
          ]),
          { id: 'status', label: `${icons.status} Посмотреть настройки` },
          {
            id: 'updates',
            label: '🔄 Версии и автоматическое применение обновлений',
            hint: 'установленная версия и работающая версия',
          },
          { id: 'exit', label: `${icons.exit} Выйти` },
        ],
        current.completed === current.total ? 'start' : 'configure',
      );
      if (action === 'exit') {
        view.finish('До встречи! Настройки сохранены.');
        return 0;
      }
      try {
        const code = action === 'start' ? await start() : undefined;
        if (code !== undefined) {
          return code;
        }
        if (action === 'start') {
          continue;
        }
        if (action === 'status') {
          view.showReport(current);
        } else if (action === 'updates') {
          await showUpdates();
        } else if (action === 'telegram-chats') {
          showTelegramAccess(state.config, ui);
        } else if (action === 'configure') {
          await configure();
        } else {
          await runSection(action as SetupSection);
        }
      } catch (error) {
        if (error instanceof SetupCancelled) {
          ui.note('Раздел отменён. Прежние настройки сохранены; можно выбрать другой пункт.');
        } else {
          view.failure(setupError(error));
        }
      }
    }
  } catch (error) {
    if (error instanceof SetupCancelled) {
      view.finish('Настройка отменена. Завершённые разделы сохранены.', true);
      return 0;
    }
    throw error;
  }
}
