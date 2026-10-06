import { pathToFileURL } from 'node:url';
import { setupError } from './cli/errors.js';

/** Compatibility entry point: there is one interactive workflow, regardless of command name. */
async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'models') {
    const { directories } = await import('./config.js');
    const { modelRuntime, subscriptionModels } = await import('./pi.js');
    await directories();
    const models = await subscriptionModels(await modelRuntime());
    console.log(models.map(model => `${model.id} — ${model.name}`).join('\n'));
    return;
  }
  const aliases: Record<string, string> = { pi: 'model', google: 'calendars', icloud: 'calendars', yandex: 'calendars' };
  const { main } = await import('./cli.js');
  await main(command ? [aliases[command] ?? command, ...process.argv.slice(3)] : []);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(setupError(error)); process.exitCode = 1; });
}
