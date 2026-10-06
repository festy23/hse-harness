import type { SetupConnections } from '../ports.js';

/** Composition point: providers load only when their setup section is used. */
export const connections: SetupConnections = {
  bot: async (...args) => (await import('./telegram.js')).bot(...args),
  telegram: async (...args) => (await import('./telegram.js')).telegram(...args),
  mail: async (...args) => (await import('./mail.js')).connectMail(...args),
  models: async (...args) => (await import('./pi.js')).connectModels(...args),
  calendars: async (...args) => (await import('./calendars.js')).connectCalendars(...args),
};
