import type { SetupConnections } from '../ports.js';

export const connections: SetupConnections = {
  bot: async (...args) => (await import('./telegram.js')).bot(...args),
  telegram: async (...args) => (await import('./telegram.js')).telegram(...args),
  mail: async (...args) => (await import('./mail.js')).connectMail(...args),
  models: async (...args) => (await import('./pi.js')).connectModels(...args),
  calendars: async (...args) => (await import('./calendars.js')).connectCalendars(...args),
};
