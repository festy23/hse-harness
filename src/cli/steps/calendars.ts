import { type CalendarProvider } from '../../config.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SetupIssue } from '../errors.js';
import type { Choice } from '../ports.js';
import type { StepContext } from './context.js';
import { hasGoogleAuth } from '../status.js';
import { icons } from '../icons.js';

export const calendarChoices: Choice[] = [
  { id: 'google', label: `${icons.calendars} Google Calendar` },
  { id: 'yandex', label: `${icons.calendars} Яндекс Календарь` },
  { id: 'icloud', label: `${icons.calendars} iCloud Calendar` },
];
export async function calendars(context: StepContext): Promise<void> {
  const { state, ui, connections } = context;
  const old = state.config.calendars;
  ui.note('Расписание — откуда читать занятия. Дедлайны — куда записывать задания.\nНужны два отдельных календаря; провайдеры могут различаться.', `${icons.calendars} Календарные роли`);
  const timetableProvider = await ui.choose('Откуда читать расписание?', calendarChoices, old.timetable.provider) as CalendarProvider;
  const agentProvider = await ui.choose('Куда записывать дедлайны?', calendarChoices, old.agent.provider) as CalendarProvider;
  const lists = new Map<CalendarProvider, Choice[]>();
  for (const provider of new Set([timetableProvider, agentProvider])) {
    const reconnect = await calendarCredentials(provider, context);
    if (provider === 'google') {
      let saved: unknown;
      try { saved = JSON.parse(await readFile(join(state.authDir, 'google.json'), 'utf8')); } catch { saved = undefined; }
      if (reconnect || !hasGoogleAuth(saved)) await state.protectAuth('google.json');
    }
    const list = await connections.calendars(provider, ui, reconnect);
    if (!list.length) throw new SetupIssue(`Нет доступных календарей ${provider}. Создай их в приложении календаря и повтори выбор`);
    lists.set(provider, list);
  }
  const timetableId = await ui.choose('Календарь расписания', lists.get(timetableProvider)!, old.timetable.provider === timetableProvider ? old.timetable.id : undefined);
  const agentOptions = lists.get(agentProvider)!.filter(choice => choice.writable !== false && (timetableProvider !== agentProvider || choice.id !== timetableId));
  if (!agentOptions.length) throw new SetupIssue('Создай отдельный календарь дедлайнов с правом записи');
  const agentId = await ui.choose('Календарь дедлайнов', agentOptions, old.agent.provider === agentProvider ? old.agent.id : undefined);
  const selected = agentOptions.find(choice => choice.id === agentId)!;
  if (selected.writable === undefined) {
    ui.note('Сервер не сообщил право записи для этого календаря. Проверь его в приложении календаря: агенту нужна запись.', 'Право записи не подтверждено');
    if (!await ui.yes('У тебя есть право записи в выбранный календарь дедлайнов?', false)) throw new SetupIssue('Выбери календарь с правом записи');
  }
  await state.calendars(
    { provider: timetableProvider, id: timetableId, label: lists.get(timetableProvider)!.find(choice => choice.id === timetableId)!.label },
    { provider: agentProvider, id: agentId, label: selected.label },
  );
  ui.note(`Расписание: ${state.config.calendars.timetable.label}\nДедлайны: ${selected.label}\nПравки расписания согласуются с тобой в боте.`, `${icons.calendars} Календари`);
}

async function calendarCredentials(provider: CalendarProvider, { ui, credential }: StepContext): Promise<boolean> {
  if (provider === 'google') {
    ui.note('https://console.cloud.google.com/ → Calendar API, OAuth consent, клиент «Desktop app».\nВ тестовом OAuth добавь свою почту в test users.', 'Google Calendar');
    const previousId = process.env.GOOGLE_CLIENT_ID;
    const previousSecret = process.env.GOOGLE_CLIENT_SECRET;
    const id = await credential({ name: 'GOOGLE_CLIENT_ID', message: 'Google OAuth client ID' });
    const secret = await credential({ name: 'GOOGLE_CLIENT_SECRET', message: 'Google OAuth client secret', secret: true });
    if ((previousId && previousId !== id) || (previousSecret && previousSecret !== secret)) {
      ui.note('OAuth-клиент изменился — нужен новый вход Google.');
      return true;
    }
    return ui.yes('Повторить вход / сменить аккаунт Google?', false);
  }
  if (provider === 'yandex') {
    ui.note('https://calendar.yandex.ru → создай отдельный календарь дедлайнов.\nhttps://id.yandex.ru/security/app-passwords → пароль приложения «Календарь».\nПочтовый пароль для календаря не подходит.', 'Яндекс Календарь');
    await credential({ name: 'YANDEX_CALENDAR_USERNAME', message: 'Аккаунт Яндекс Календаря', initial: process.env.YANDEX_ADDRESS });
    await credential({ name: 'YANDEX_CALENDAR_APP_PASSWORD', message: 'Пароль приложения «Календарь»', secret: true });
  } else {
    ui.note('https://account.apple.com → Sign-In and Security → App-Specific Passwords.\nВыбираемые календари должны храниться в iCloud.', 'iCloud Calendar');
    await credential({ name: 'ICLOUD_USERNAME', message: 'Apple Account (почта)' });
    await credential({ name: 'ICLOUD_APP_PASSWORD', message: 'Пароль приложения iCloud', secret: true });
  }
  return false;
}
