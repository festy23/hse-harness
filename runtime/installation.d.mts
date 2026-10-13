export interface ReleaseDescriptor { version:string; integrity:string; releasePath:string; packageRoot:string; manifest:Record<string,unknown> }
export interface InstallationOptions { home:string; packageRoot:string; node?:string; npm?:string; releaseStore?:unknown }
export function installRuntime(options:InstallationOptions):Promise<{launcher:string;active:ReleaseDescriptor}>;
export function startManaged(options:InstallationOptions):Promise<number>;
export function updateSettings(home:string, change:{enabled:boolean}):Promise<unknown>;
export function requestUpdate(home:string, request:{action:'retry'|'rollback'}):Promise<unknown>;
export function readRuntimeStatus(home:string):Promise<Record<string,unknown>>;
