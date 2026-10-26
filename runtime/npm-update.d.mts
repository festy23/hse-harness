export function grantTelegramUpdate(home: string, id: string): Promise<void>;
export function restoreTelegramUpdatePermission(home: string, id: string): Promise<void>;
export function installApprovedPackage(options: {
  home: string;
  version: string;
  integrity: string;
  signal: AbortSignal;
}): Promise<void>;
