import type { Config } from '../config.js';
import type { SetupUI } from './ports.js';
import { messengerMark, providerLabel } from './icons.js';

/** Read-only view of the same chat allowlist used by history and approved questions. */
export function showTelegramAccess(config: Pick<Config, 'ownerId' | 'chats'>, ui: Pick<SetupUI, 'note'>): void {
  const label = providerLabel(messengerMark('telegram'));
  ui.note(config.ownerId
    ? `Владелец: ${config.ownerId}\nБот принимает команды и сообщения только от тебя в личном чате.\nОтветы и уведомления приходят от аккаунта бота.`
    : 'Владелец ещё не настроен. Подключи Telegram через меню.', `${label} · Личный диалог`);

  if (!config.chats.length) {
    ui.note('Учебные чаты пока не выбраны.\nДобавить источники: npm run harness -- telegram', `${label} · Разрешённые чаты`);
    return;
  }
  const entries = config.chats.map((chat, index) =>
    `${index + 1}. ${chat.title}\n   ID: ${chat.id}\n   👁️ Читать · ✍️ Вопрос после подтверждения`
  );
  ui.note(entries.join('\n\n'), `${label} · Разрешённые чаты (${entries.length})`);
  ui.note('👁️ Чтение сообщений и истории — личным Telegram-аккаунтом.\n✍️ Отправка вопроса — от твоего аккаунта после одобрения черновика в боте.\nЧаты вне этого списка читать и использовать для вопросов нельзя.\nОтправка также требует прав Telegram; в канале она может быть запрещена.\nПоказана сохранённая конфигурация, доступность чатов сейчас не проверялась.', '📋 Правила доступа');
}
