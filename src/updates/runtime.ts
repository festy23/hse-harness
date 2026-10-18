import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {AvailableRelease} from './releases.js';

export interface UpdateSnapshot {runningVersion:string;installedVersion:string;updatesEnabled:boolean;automaticUpdates:boolean;stable:boolean;quarantined:string[];retryPending?:boolean;deferredReason?:string}
export type UpdateInstall = AvailableRelease & {automatic?:boolean};
export interface UpdateRuntime {
  snapshot():Promise<UpdateSnapshot|undefined>;
  setAutomatic(enabled:boolean):Promise<void>;
  grant(id:string):Promise<void>;
  restore(id:string):Promise<void>;
  install(release:UpdateInstall,signal:AbortSignal):Promise<void>;
}
export function updateRuntime(home:string|undefined,managed:boolean):UpdateRuntime {
  const api=async()=>await import(new URL('../../runtime/npm-update.mjs',import.meta.url).href);
  return {
    async snapshot(){
      if(!managed||!home)return undefined;
      const r=JSON.parse(await readFile(join(home,'runtime/state.json'),'utf8'));
      const settings=JSON.parse(await readFile(join(home,'runtime/settings.json'),'utf8'));
      // npm can temporarily remove or partially extract its mutable manifest.
      const pkg=await readFile(r.installation.manifestPath,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT'||error instanceof SyntaxError)return {version:r.installedVersion??r.active.version};throw error;});
      return {runningVersion:process.env.HSE_RELEASE_VERSION??r.runningVersion??r.active.version,installedVersion:pkg.version,updatesEnabled:settings.enabled!==false,automaticUpdates:settings.automaticUpdates===true,stable:!r.attempt&&r.active.version===(process.env.HSE_RELEASE_VERSION??r.runningVersion),quarantined:(r.quarantine??[]).map((q:{version:string})=>q.version),retryPending:settings.request?.action==='retry'&&settings.request.id!==r.lastRequestId,deferredReason:r.deferredReason??undefined};
    },
    async setAutomatic(enabled){if(!managed||!home)throw Error('Managed runtime required');await (await api()).setAutomaticUpdates(home,enabled);},
    async grant(id){if(!home)throw Error('Managed runtime required');await (await api()).grantTelegramUpdate(home,id);},
    async restore(id){if(home)await (await api()).restoreTelegramUpdatePermission(home,id);},
    async install(release,signal){if(!home)throw Error('Managed runtime required');await (await api()).installApprovedPackage({home,...release,signal});},
  };
}
