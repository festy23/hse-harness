import { pathToFileURL } from 'node:url';
import { runCLI } from './cli/application.js';
import { setupError } from './cli/errors.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runCLI(args);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(setupError(error)); process.exitCode = 1; });
}
