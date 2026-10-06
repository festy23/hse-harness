import { pathToFileURL } from 'node:url';
import { runCLI } from './cli/application.js';
import { setupError } from './cli/errors.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  try { process.exitCode = await runCLI(args); }
  catch (error) { console.error(setupError(error)); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
