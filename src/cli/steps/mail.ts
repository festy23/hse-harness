import type { StepContext } from './context.js';
import { icons } from '../icons.js';

export async function mail({ state, ui, connections, credential }: StepContext): Promise<void> {
  ui.note('Включи IMAP в настройках Яндекс Почты.\nhttps://id.yandex.ru/security/app-passwords → пароль приложения «Почта».', `${icons.mail} Учебная почта`);
  await credential({ name: 'YANDEX_ADDRESS', message: 'Адрес учебной Яндекс Почты', validate: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? undefined : 'Введите адрес почты' });
  await credential({ name: 'YANDEX_APP_PASSWORD', message: 'Пароль приложения «Почта»', secret: true });
  const folders = await connections.mail(ui);
  state.config.folders = await ui.many('Папки для чтения; пустой выбор — все, кроме спама, корзины и черновиков', folders, state.config.folders);
  await state.save();
  ui.note(`Папки: ${state.config.folders.join(', ') || 'все доступные, кроме служебных'}\nЧитается только текст, без вложений.`, `${icons.mail} Яндекс Почта`);
}
