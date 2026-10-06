// Compatibility exports for existing integrations. Implementation lives behind the CLI modules.
export { SetupState, upsertEnv } from './cli/state.js';
export { Onboarding } from './cli/onboarding.js';
export { SetupIssue, SetupCancelled } from './cli/errors.js';
export type { Choice, SetupUI, SetupConnections } from './cli/ports.js';
