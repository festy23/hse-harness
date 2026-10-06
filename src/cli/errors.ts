/** Expected errors are safe to display; SDK errors can contain credentials and stay private. */
export class SetupIssue extends Error {}
export class SetupCancelled extends Error {
  constructor() { super('Настройка отменена'); }
}
export function setupError(error: unknown): string {
  return error instanceof SetupIssue ? error.message : 'Не удалось завершить шаг. Проверь данные и соединение; прежние настройки сохранены.';
}
