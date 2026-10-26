import { parseRecord, record, requiredString, isRecord } from '../validation.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AvailableRelease } from './releases.js';

export interface UpdateSnapshot {
  runningVersion: string;
  installedVersion: string;
  updatesEnabled: boolean;
  stable: boolean;
  quarantined: string[];
  retryPending?: boolean;
  deferredReason?: string;
}
export interface UpdateRuntime {
  snapshot(): Promise<UpdateSnapshot | undefined>;
  grant(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  install(release: AvailableRelease, signal: AbortSignal): Promise<void>;
}
export function updateRuntime(home: string | undefined, managed: boolean): UpdateRuntime {
  const api = async () => await import('../../runtime/npm-update.mjs');
  return {
    async snapshot() {
      if (!managed || !home) {
        return undefined;
      }
      const r = parseRecord(await readFile(join(home, 'runtime/state.json'), 'utf8'));
      const settings = parseRecord(await readFile(join(home, 'runtime/settings.json'), 'utf8'));
      const active = record(r.active),
        installation = record(r.installation);
      const pkg = await readFile(requiredString(installation.manifestPath), 'utf8')
        .then(parseRecord)
        .catch((error: unknown) => {
          if (isRecord(error) && error.code === 'ENOENT') {
            return { version: r.installedVersion ?? active.version };
          }
          throw error;
        });
      const quarantine: unknown = r.quarantine ?? [];
      if (!Array.isArray(quarantine)) {
        throw new Error('Invalid runtime quarantine');
      }
      const request = settings.request === undefined ? undefined : record(settings.request);
      return {
        runningVersion: requiredString(
          process.env.HSE_RELEASE_VERSION ?? r.runningVersion ?? active.version,
        ),
        installedVersion: requiredString(pkg.version),
        updatesEnabled: settings.enabled !== false,
        stable:
          !r.attempt && active.version === (process.env.HSE_RELEASE_VERSION ?? r.runningVersion),
        quarantined: quarantine.map((q: unknown) => requiredString(record(q).version)),
        retryPending: request?.action === 'retry' && request.id !== r.lastRequestId,
        deferredReason:
          r.deferredReason === null || r.deferredReason === undefined
            ? undefined
            : requiredString(r.deferredReason),
      };
    },
    async grant(id) {
      if (!home) {
        throw Error('Managed runtime required');
      }
      await (await api()).grantTelegramUpdate(home, id);
    },
    async restore(id) {
      if (home) {
        await (await api()).restoreTelegramUpdatePermission(home, id);
      }
    },
    async install(release, signal) {
      if (!home) {
        throw Error('Managed runtime required');
      }
      await (await api()).installApprovedPackage({ home, ...release, signal });
    },
  };
}
