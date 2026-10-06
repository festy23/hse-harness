/** Compact terminal marks shared by menus, status cards and setup sections. */
export const icons = {
  profile: '👤', mail: '✉️', calendars: '📅', communication: '📡',
  configure: '⚙️', start: '▶️', status: '📋', exit: '🚪',
  saved: '✅', missing: '❌',
};

export interface ProviderMark { icon: string; name: string }
const models: Record<string, ProviderMark> = {
  openai: { icon: '>_', name: 'Codex' },
  'openai-codex': { icon: '>_', name: 'Codex' },
  codex: { icon: '>_', name: 'Codex' },
  anthropic: { icon: '✳️', name: 'Claude' },
  claude: { icon: '✳️', name: 'Claude' },
  deepseek: { icon: '🐋', name: 'DeepSeek' },
};
const messengers: Record<string, ProviderMark> = {
  telegram: { icon: '✈️', name: 'Telegram' },
  yandex: { icon: '💬', name: 'Яндекс Мессенджер' },
};

// These are display mappings; they do not enable unsupported account connections.
export function modelMark(provider: string): ProviderMark {
  return models[provider.toLowerCase()] ?? { icon: '🤖', name: 'AI' };
}
export function messengerMark(provider: string): ProviderMark {
  return messengers[provider.toLowerCase()] ?? { icon: '💬', name: provider };
}
export function providerLabel(mark: ProviderMark): string { return `${mark.icon} ${mark.name}`; }
