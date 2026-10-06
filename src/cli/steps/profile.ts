import { type StudyProfile } from '../../config.js';
import type { StepContext } from './context.js';

export function academicYear(now = new Date()): string {
  const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}/${String(year + 1).slice(-2)}`;
}
export async function profile({ state, ui }: StepContext): Promise<void> {
  const old = state.config.profile;
  const value: StudyProfile = {
    name: await ui.input({ message: 'Как тебя зовут?', initial: old?.name }),
    university: await ui.input({ message: 'Вуз / факультет', initial: old?.university ?? 'ВШЭ ФКН' }),
    program: await ui.input({ message: 'Образовательная программа', initial: old?.program }),
    group: await ui.input({ message: 'Учебная группа', initial: old?.group }),
    course: Number(await ui.input({ message: 'Курс', initial: old ? String(old.course) : '', validate: v => /^[1-6]$/.test(v) ? undefined : 'Введите курс от 1 до 6' })),
    academicYear: await ui.input({ message: 'Учебный год', initial: old?.academicYear ?? academicYear(), validate: v => /^\d{4}\/\d{2}$/.test(v) ? undefined : 'Формат: 2026/27' }),
    subjects: await ui.input({ message: 'Предметы через запятую', initial: old?.subjects }),
    details: await ui.input({ message: 'Поток, майнор, НИС — можно оставить пустым', initial: old?.details, optional: true }),
  };
  await state.profile(value);
}
