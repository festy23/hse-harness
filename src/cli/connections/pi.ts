import { SetupCancelled, SetupIssue } from '../errors.js';
import type { Choice, SetupUI } from '../ports.js';

export async function connectModels(ui: SetupUI, reconnect: boolean): Promise<Choice[]> {
  let cancelled = false;
  let stage: 'login' | 'catalogue' = 'login';
  try {
    const { modelRuntime, loginSubscription, subscriptionModels } = await import('../../pi.js');
    const runtime = await modelRuntime();

    if (reconnect || !runtime.isUsingSubscription('openai')) {
      await loginSubscription(runtime, {
        async prompt(prompt) {
          try {
            if (prompt.type === 'select') {
              return await ui.choose(prompt.message, prompt.options.map(option => ({
                id: option.id,
                label: option.label,
              })));
            }
            return await ui.input({
              message: prompt.message,
              secret: prompt.type === 'secret' || prompt.type === 'manual_code',
              signal: prompt.signal,
            });
          } catch (error) {
            cancelled = error instanceof SetupCancelled || (
              prompt.type !== 'select' && Boolean(prompt.signal?.aborted)
            );
            throw error;
          }
        },
        notify(event) {
          if (event.type === 'auth_url') {
            ui.note(`${event.url}\n${event.instructions ?? ''}`, 'Вход в ChatGPT');
          } else if (event.type === 'device_code') {
            ui.note(`${event.verificationUri}\nКод: ${event.userCode}`, 'Вход в ChatGPT');
          } else {
            ui.note(event.message);
          }
        },
      });
    }

    stage = 'catalogue';
    const models = await ui.task('Получаю модели твоей подписки', async (signal?: AbortSignal) => {
      if (signal?.aborted) throw new SetupCancelled();
      const request: typeof fetch = (input, options) => {
        if (signal?.aborted) throw new SetupCancelled();
        return fetch(input, {
          ...options,
          signal: AbortSignal.any([options?.signal ?? AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
        });
      };
      try {
        // Native getAuth may rotate tokens. Do not return until that work settles,
        // so a section rollback cannot be followed by an orphaned auth write.
        const result = await subscriptionModels(runtime, request);
        if (signal?.aborted) throw new SetupCancelled();
        return result;
      } catch (error) {
        if (signal?.aborted) throw new SetupCancelled();
        throw error;
      }
    });
    return models.map(model => ({ id: model.id, label: model.name, hint: model.id }));
  } catch (error) {
    if (cancelled || error instanceof SetupCancelled) throw new SetupCancelled();
    throw new SetupIssue(stage === 'login'
      ? 'ChatGPT: не удалось завершить вход. Повтори подключение подписки в меню.'
      : 'ChatGPT: не удалось получить модели. Проверь соединение; при истёкшем входе подключи подписку заново.');
  }
}
