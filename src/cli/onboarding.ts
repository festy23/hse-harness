import { profile } from './steps/profile.js';
import { telegram } from './steps/telegram.js';
import { mail } from './steps/mail.js';
import { model } from './steps/model.js';
import { calendars } from './steps/calendars.js';
import type { StepContext, CredentialRequest } from './steps/context.js';
import type { SetupSection, SetupUI, SetupConnections } from './ports.js';
import type { SetupState } from './state.js';
import { icons, modelMark, messengerMark, providerLabel } from './icons.js';

export const sections: { id: SetupSection; title: string }[] = [
  { id: 'profile', title: `${icons.profile} Информация о тебе` },
  { id: 'telegram', title: `${icons.communication} Каналы связи · ${providerLabel(messengerMark('telegram'))}` },
  { id: 'mail', title: `${icons.mail} Яндекс Почта` },
  { id: 'model', title: `${providerLabel(modelMark('openai'))} · Подписка и модель` },
  { id: 'calendars', title: `${icons.calendars} Расписание и дедлайны` },
];
const steps = { profile, telegram, mail, model, calendars };

/** Runs the same complete section from the menu, wizard, or a direct CLI command. */
export class Onboarding {
  constructor(readonly state: SetupState, readonly ui: SetupUI, readonly connections: SetupConnections) {}

  async run(section: SetupSection): Promise<void> {
    const context: StepContext = {
      state: this.state, ui: this.ui, connections: this.connections,
      credential: request => this.credential(request),
    };
    await this.state.transaction(() => steps[section](context));
  }

  private async credential(request: CredentialRequest): Promise<string> {
    const existing = process.env[request.name];
    if (existing && !request.validate?.(existing) && await this.ui.yes(`${request.message}: оставить сохранённое значение?`, true)) return existing;
    const value = await this.ui.input({
      message: request.message, secret: request.secret,
      initial: request.secret ? undefined : existing ?? request.initial,
      validate: request.validate,
    });
    await this.state.env(request.name, value);
    return value;
  }
}
