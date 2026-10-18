import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {ReleaseStore,runInstaller} from './releases.mjs';
import {findNpm} from './executable.mjs';
import {readJSON,acquireLock,atomicJSON} from './storage.mjs';
import {stableVersion,PACKAGE_NAME} from './manifest.mjs';
import {compatible,compareVersions} from './supervisor.mjs';
import {requestUpdate} from './installation.mjs';

/** Owner policy for discovering and installing new releases, separate from hot application. */
export async function setAutomaticUpdates(home,enabled) {
  if(typeof enabled!=='boolean')throw Error('automaticUpdates must be boolean');
  const root=join(resolve(home),'runtime'),release=await acquireLock(join(root,'settings.lock'));
  try {
    const settings=await readJSON(join(root,'settings.json'),{enabled:true});
    settings.automaticUpdates=enabled;
    await atomicJSON(join(root,'settings.json'),settings);
  } finally {await release();}
}

export async function grantTelegramUpdate(home,id) {
  const root=join(resolve(home),'runtime'),release=await acquireLock(join(root,'settings.lock'));
  try{const settings=await readJSON(join(root,'settings.json'),{enabled:true});if(settings.enabled===false){settings.enabled=true;settings.telegramUpdatePermission=id;await atomicJSON(join(root,'settings.json'),settings);}}
  finally{await release();}
}
export async function restoreTelegramUpdatePermission(home,id) {
  const root=join(resolve(home),'runtime'),release=await acquireLock(join(root,'settings.lock'));
  try{const settings=await readJSON(join(root,'settings.json'),{enabled:true});if(settings.telegramUpdatePermission===id){settings.enabled=false;delete settings.telegramUpdatePermission;await atomicJSON(join(root,'settings.json'),settings);}}
  finally{await release();}
}
/** Native owner callback or explicit automatic policy; never exposed to the model. */
export async function installApprovedPackage({home,version,integrity,signal,automatic=false}) {
  if(!stableVersion(version)||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)||typeof automatic!=='boolean')throw Error('Invalid update identity');
  const root=resolve(home),journal=await readJSON(join(root,'runtime/state.json'));
  const manifestPath=resolve(journal.installation.manifestPath);
  const suffix=join('lib','node_modules',PACKAGE_NAME,'package.json');
  if(!manifestPath.endsWith('/'+suffix))throw Error('Telegram updates require a permanent global npm installation');
  const prefix=manifestPath.slice(0,-suffix.length-1);
  const npm=await findNpm();
  const store=new ReleaseStore(root,{npm,node:process.execPath});
  const target=await store.prepare(version,{signal});
  if(target.integrity!==integrity)throw Error('Update integrity changed');
  if(!compatible(journal.active,target)||compareVersions(journal.supervisorVersion,target.manifest.minSupervisorVersion)<0)throw Object.assign(Error('This release requires a serviced runtime upgrade'),{code:'RUNTIME_UPGRADE_REQUIRED'});
  const current=await readFile(manifestPath,'utf8').then(JSON.parse).catch(error=>{
    if(error.code==='ENOENT')return {version:journal.installedVersion??journal.active.version};
    throw error;
  });
  if(!stableVersion(current.version)||compareVersions(current.version,version)>0)throw Error('A newer package is already installed');
  const settings=await readJSON(join(root,'runtime/settings.json'),{enabled:true});
  if(settings.enabled===false)throw Error('Update application was disabled');
  if(automatic&&settings.automaticUpdates!==true)throw Object.assign(Error('Automatic updates were disabled'),{code:'AUTOMATIC_UPDATES_DISABLED'});
  // Preparation can overlap a supervisor rollback; never turn policy into a retry grant.
  const latestJournal=await readJSON(join(root,'runtime/state.json'));
  if(automatic&&(latestJournal.quarantine?.some(q=>q.version===version)||latestJournal.manualHold?.version===version))throw Object.assign(Error('Automatic retry of a held release is forbidden'),{code:'AUTOMATIC_UPDATE_HELD'});
  if(current.version===version){
    // An explicit new owner approval may retry an installed, rolled-back release.
    if(latestJournal.quarantine?.some(q=>q.version===version)||latestJournal.manualHold?.version===version)await requestUpdate(root,{action:'retry'});
    return;
  }
  const scratch=await mkdtemp(join(root,'runtime','.telegram-install-'));
  try {
    const userConfig=join(scratch,'user.npmrc'),globalConfig=join(scratch,'global.npmrc');
    await writeFile(userConfig,'',{mode:0o600});await writeFile(globalConfig,'',{mode:0o600});
    // No study credentials, model auth, worker IPC or application preload context.
    const env={PATH:[dirname(process.execPath),dirname(npm),'/usr/bin','/bin'].join(':'),HOME:process.env.HOME};
    for(const key of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy','NODE_USE_ENV_PROXY','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS'])if(process.env[key])env[key]=process.env[key];
    await runInstaller(npm,['install','--global','--prefix',prefix,`${PACKAGE_NAME}@${version}`,'--omit=dev','--ignore-scripts','--engine-strict','--no-audit','--no-fund','--loglevel=error','--registry=https://registry.npmjs.org/',`--userconfig=${userConfig}`,`--globalconfig=${globalConfig}`,`--cache=${join(scratch,'cache')}`,'--fetch-retries=0','--fetch-timeout=120000'],{cwd:scratch,env,signal,timeout:300000});
    if(JSON.parse(await readFile(manifestPath,'utf8')).version!==version)throw Error('npm did not install the requested version');
  }finally{await rm(scratch,{recursive:true,force:true});}
}
