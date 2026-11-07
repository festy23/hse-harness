import { test } from 'node:test';
import assert from 'node:assert/strict';
test('version-bound proxy compatibility injects the client factory before connect and preserves explicit factories', async () => {
  const { installTelegramFactoryCompatibility } = await import(
    new URL('../deploy/telegram-wss-compat.mjs', import.meta.url).href
  );
  class Source {
    options?: { configPath?: string; createClient: (session: string) => string };
    async connect() {
      return this.options?.createClient('fixture');
    }
  }
  installTelegramFactoryCompatibility(Source, (s: string) => 'injected:' + s);
  assert.equal(await new Source().connect(), 'injected:fixture');
  const selected = new Source();
  selected.options = { configPath: 'keep', createClient: () => 'explicit' };
  assert.equal(await selected.connect(), 'explicit');
  assert.equal(selected.options!.configPath, 'keep');
});
