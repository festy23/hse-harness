import { SetupIssue } from '../errors.js';
import type { StepContext } from './context.js';
import { icons, messengerMark, providerLabel } from '../icons.js';

export async function telegram({ state, ui, connections, credential }: StepContext): Promise<void> {
  const label = providerLabel(messengerMark('telegram'));
  ui.note(`${label} — личный бот и чтение учебных чатов\n${providerLabel(messengerMark('yandex'))} — пока недоступен`, `${icons.communication} Коннекторы связи`);
  ui.note('Бот: https://t.me/BotFather → /newbot\nAPI ID и API hash: https://my.telegram.org → API development tools\nБот отвечает тебе; личный аккаунт читает выбранные источники.', 'Где получить данные');
  const token = await credential({ name: 'TELEGRAM_BOT_TOKEN', message: 'Токен Telegram-бота', secret: true });
  const username = await connections.bot(token, ui);
  await credential({ name: 'TELEGRAM_API_ID', message: 'Telegram API ID', validate: v => /^[1-9]\d*$/.test(v) ? undefined : 'Нужен числовой API ID' });
  await credential({ name: 'TELEGRAM_API_HASH', message: 'Telegram API hash', secret: true });
  await state.protectAuth('telegram.session');
  const account = await connections.telegram(ui, state.config.ownerId || undefined);
  if (state.config.ownerId && state.config.ownerId !== account.ownerId) throw new SetupIssue('Для другого владельца используй отдельную установку');
  const old = state.config.chats;
  const unavailable = old.filter(chat => !account.chats.some(choice => choice.id === chat.id));
  if (unavailable.length) ui.note('Некоторые сохранённые чаты сейчас недоступны. Они останутся отмеченными; сними отметку, если больше не хочешь их читать.', 'Сохранённые источники');
  const choices = [...account.chats, ...unavailable.map(chat => ({ id: chat.id, label: chat.title, hint: 'сохранён, сейчас недоступен' }))];
  const ids = await ui.many('Чаты и каналы для чтения', choices, old.map(chat => chat.id));
  state.config.ownerId = account.ownerId;
  state.config.chats = ids.map(id => ({ id, title: choices.find(choice => choice.id === id)!.label }));
  await state.save();
  ui.note(`Выбрано источников: ${ids.length}\nЛичный диалог: https://t.me/${username} → Start\nownerId определён автоматически.`, label);
}
