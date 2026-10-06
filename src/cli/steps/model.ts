import { SetupIssue } from '../errors.js';
import { hasSubscription } from '../status.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StepContext } from './context.js';
import { modelMark, providerLabel } from '../icons.js';

export async function model({ state, ui, connections }: StepContext): Promise<void> {
  const label = `${providerLabel(modelMark('openai'))} · Подписка LLM`;
  ui.note('OpenAI / ChatGPT — подписочный вход через Pi. API-ключ не требуется.', label);
  const reconnect = await ui.yes('Повторить вход / сменить аккаунт подписки?', false);
  let saved: unknown;
  try { saved = JSON.parse(await readFile(join(state.authDir, 'pi-auth.json'), 'utf8')); } catch { saved = undefined; }
  if (reconnect || !hasSubscription(saved)) await state.protectAuth('pi-auth.json');
  const models = await connections.models(ui, reconnect);
  if (!models.length) throw new SetupIssue('По подписке нет моделей, поддержанных Pi');
  state.config.model = await ui.choose('Модель из каталога твоей подписки', models, state.config.model);
  await state.save();
  ui.note(`Выбрана модель: ${state.config.model}`, label);
}
