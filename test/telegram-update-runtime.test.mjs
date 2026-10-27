import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ReleaseStore} from '../runtime/releases.mjs';
import {atomicJSON,readJSON} from '../runtime/storage.mjs';
import {grantTelegramUpdate,restoreTelegramUpdatePermission,installApprovedPackage,setAutomaticUpdates} from '../runtime/npm-update.mjs';
import {updateSettings} from '../runtime/installation.mjs';
const integrity='sha512-'+Buffer.alloc(64,1).toString('base64');
const manifest={protocolVersion:1,stateSchemaVersion:2,piVersion:'1.0.2',minSupervisorVersion:'1.0.0',formats:{operations:2,auth:1},writableStateVersion:2};
test('one-off application permission recovers idempotently and respects subsequent explicit CLI preferences',async t=>{
 const home=await mkdtemp(join(tmpdir(),'hse-grant-'));t.after(()=>rm(home,{recursive:true,force:true}));
 await updateSettings(home,{enabled:false});await grantTelegramUpdate(home,'one');await grantTelegramUpdate(home,'one');
 assert.equal((await readJSON(join(home,'runtime/settings.json'))).enabled,true);
 await restoreTelegramUpdatePermission(home,'other');assert.equal((await readJSON(join(home,'runtime/settings.json'))).enabled,true);
 await restoreTelegramUpdatePermission(home,'one');assert.equal((await readJSON(join(home,'runtime/settings.json'))).enabled,false);
 await grantTelegramUpdate(home,'two');await updateSettings(home,{enabled:true});await restoreTelegramUpdatePermission(home,'two');assert.equal((await readJSON(join(home,'runtime/settings.json'))).enabled,true);
});
test('owner installer verifies before mutation, pins the global prefix, isolates credentials and queues quarantine retry',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'hse-owner-install-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const home=join(dir,'home'),prefix=join(dir,'npm prefix'),manifestPath=join(prefix,'lib/node_modules/@ivan-boss/hse-harness/package.json');
 await mkdir(join(prefix,'lib/node_modules/@ivan-boss/hse-harness'),{recursive:true});await mkdir(home);
 await writeFile(manifestPath,JSON.stringify({version:'0.2.2'}));
 const journal={installation:{manifestPath},active:{version:'0.2.2',manifest},supervisorVersion:'1.0.0',quarantine:[]};await atomicJSON(join(home,'runtime/state.json'),journal);await updateSettings(home,{enabled:true});
 const command=join(dir,'npm'),log=join(dir,'invocation.json');
 await writeFile(command,`#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({args,env:process.env,user:fs.readFileSync(args.find(x=>x.startsWith('--userconfig=')).slice(13),'utf8')}));fs.writeFileSync(${JSON.stringify(manifestPath)},JSON.stringify({version:'0.2.3'}));`,{mode:0o700});
 // npm is a executable file, independent of cwd; the SDK preparation boundary is already exhaustively covered by ReleaseStore tests.
 const previous=ReleaseStore.prototype.prepare,oldNpm=process.env.npm_execpath,oldToken=process.env.TELEGRAM_BOT_TOKEN;
 process.env.npm_execpath=command;process.env.TELEGRAM_BOT_TOKEN='private-credential';let verified=false;
 ReleaseStore.prototype.prepare=async()=>{assert.equal(JSON.parse(await readFile(manifestPath)).version,'0.2.2');verified=true;return {version:'0.2.3',integrity,manifest};};
 t.after(()=>{ReleaseStore.prototype.prepare=previous;if(oldNpm===undefined)delete process.env.npm_execpath;else process.env.npm_execpath=oldNpm;if(oldToken===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=oldToken;});
 await assert.rejects(installApprovedPackage({home,version:'0.2.3',integrity:'sha512-'+Buffer.alloc(64,2).toString('base64')}),/integrity changed/);
 await installApprovedPackage({home,version:'0.2.3',integrity});assert.ok(verified);
 const invoked=JSON.parse(await readFile(log));assert.ok(invoked.args.includes('@ivan-boss/hse-harness@0.2.3'));assert.equal(invoked.args[invoked.args.indexOf('--prefix')+1],prefix);assert.ok(invoked.args.includes('--ignore-scripts'));assert.equal(invoked.env.TELEGRAM_BOT_TOKEN,undefined);assert.equal(invoked.env.NODE_OPTIONS,undefined);assert.equal(invoked.user,'');assert.ok(!(await readdir(join(home,'runtime'))).some(x=>x.startsWith('.telegram-install-')));
 ReleaseStore.prototype.prepare=async()=>({version:'0.2.3',integrity,manifest});journal.quarantine=[{version:'0.2.3'}];await atomicJSON(join(home,'runtime/state.json'),journal);
 await installApprovedPackage({home,version:'0.2.3',integrity});assert.equal((await readJSON(join(home,'runtime/settings.json'))).request.action,'retry');
});

for(const revocation of ['policy','quarantine'])test(`revoking automatic ${revocation} during preparation prevents global npm mutation`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'hse-auto-install-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const home=join(dir,'home'),manifestPath=join(dir,'prefix/lib/node_modules/@ivan-boss/hse-harness/package.json');
 await mkdir(join(dir,'prefix/lib/node_modules/@ivan-boss/hse-harness'),{recursive:true});
 await writeFile(manifestPath,JSON.stringify({version:'0.2.2'}));
 await atomicJSON(join(home,'runtime/state.json'),{installation:{manifestPath},active:{version:'0.2.2',manifest},supervisorVersion:'1.0.1',quarantine:[]});
 await updateSettings(home,{enabled:true});await setAutomaticUpdates(home,true);
 const previous=ReleaseStore.prototype.prepare;t.after(()=>{ReleaseStore.prototype.prepare=previous;});
 ReleaseStore.prototype.prepare=async()=>{
   if(revocation==='policy')await setAutomaticUpdates(home,false);
   else {const path=join(home,'runtime/state.json');await atomicJSON(path,{...await readJSON(path),quarantine:[{version:'0.2.3'}]});}
   return {version:'0.2.3',integrity,manifest};
 };
 await assert.rejects(installApprovedPackage({home,version:'0.2.3',integrity,automatic:true}),{code:revocation==='policy'?'AUTOMATIC_UPDATES_DISABLED':'AUTOMATIC_UPDATE_HELD'});
 assert.equal(JSON.parse(await readFile(manifestPath)).version,'0.2.2');
 assert.ok(!(await readdir(join(home,'runtime'))).some(x=>x.startsWith('.telegram-install-')));
});
