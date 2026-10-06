import * as p from '@clack/prompts';
import { styleText } from 'node:util';
import { SetupCancelled } from './errors.js';
import type { SetupUI } from './ports.js';
import type { SetupReport } from './status.js';
import { withProgress } from './progress.js';
import { showBrand } from './brand.js';
import { icons } from './icons.js';

// Clack exports these instruction arrays; localize through the supported surface.
p.SELECT_INSTRUCTIONS.splice(0, p.SELECT_INSTRUCTIONS.length, '↑ ↓ — выбрать', 'Enter — подтвердить');
p.MULTISELECT_INSTRUCTIONS.splice(0, p.MULTISELECT_INSTRUCTIONS.length, 'Пробел — отметить', 'Enter — сохранить');
p.updateSettings({ messages: { cancel: 'Отменено', error: 'Не удалось завершить' } });

export async function unwrap<T>(promise: Promise<T>): Promise<Exclude<T, symbol>> {
  const value = await promise;
  if (p.isCancel(value)) throw new SetupCancelled();
  return value as Exclude<T, symbol>;
}

export const terminal: SetupUI = {
  async input({ message, initial = '', secret = false, optional = false, validate, signal }) {
    const check = (value: string | undefined) => !value?.trim() && !optional ? 'Заполни поле' : validate?.(value?.trim() ?? '');
    const prompt = secret ? p.password({ message, validate: check, signal }) : p.text({ message, initialValue: initial, validate: check, signal });
    return (await unwrap(prompt)).trim();
  },
  choose(message, choices, initial) {
    return unwrap(p.select({ message, options: choices.map(c => ({ value: c.id, label: c.label, hint: c.hint })), initialValue: choices.some(c => c.id === initial) ? initial : undefined }));
  },
  many(message, choices, selected) {
    if (!choices.length) { p.log.info('Список пуст — выбирать нечего.'); return Promise.resolve([]); }
    p.log.info('Печатай название для поиска · Пробел — отметить · Enter — сохранить');
    return unwrap(p.autocompleteMultiselect({ message, placeholder: 'Поиск по названию…', options: choices.map(c => ({ value: c.id, label: c.label, hint: c.hint })), initialValues: selected.filter(id => choices.some(c => c.id === id)), required: false, maxItems: 8 }));
  },
  yes(message, initial = true) { return unwrap(p.confirm({ message, initialValue: initial, active: 'Да', inactive: 'Нет' })); },
  note(message, title) { title ? p.note(message, title) : p.log.info(message); },
  task: withProgress,
};

export function welcome(): void {
  showBrand();
  p.intro(styleText(['bold', 'blue'], 'HSE HARNESS'));
}
export function showReport(report: SetupReport): void {
  const lines = report.rows.map(row => `${row.ready ? icons.saved : icons.missing} ${row.title} · ${row.detail.split('\n').join(' · ')}`);
  lines.push(`\n${report.pid ? `● Бот работает · PID ${report.pid}` : '○ Бот остановлен'}`);
  p.note(lines.join('\n'), `${report.name ? report.name + ' · ' : ''}Сохранено ${report.completed}/${report.total}`);
}
export function step(title: string): void { p.log.step(title); }
export function success(title: string): void { p.log.success(`${icons.saved} ${title}`); }
export function failure(message: string): void { p.log.error(message); }
export function finish(message: string, cancelled = false): void { cancelled ? p.cancel(message) : p.outro(message); }
