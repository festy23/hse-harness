import type { SetupUI, SetupConnections } from '../ports.js';
import type { SetupState } from '../state.js';

export interface CredentialRequest {
  name: string;
  message: string;
  secret?: boolean;
  initial?: string;
  validate?: (value: string) => string | undefined;
}
export interface StepContext {
  state: SetupState;
  ui: SetupUI;
  connections: SetupConnections;
  credential(request: CredentialRequest): Promise<string>;
}
