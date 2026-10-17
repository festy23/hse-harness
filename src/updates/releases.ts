import {withOperation,type OperationContext} from '../operations.js';
export const PACKAGE_NAME='@ivan-boss/hse-harness';
export interface AvailableRelease {version:string;integrity:string}
export const stableVersion=(value:unknown):value is string=>typeof value==='string'&&value.length<=64&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export function compareVersions(a:string,b:string):number {
  if(!stableVersion(a)||!stableVersion(b))throw new Error('Ожидается стабильная версия npm');
  const x=a.split('.').map(BigInt),y=b.split('.').map(BigInt);
  for(let i=0;i<3;i++){if(x[i]!>y[i]!)return 1;if(x[i]!<y[i]!)return -1;}return 0;
}
export async function latestRelease(request:typeof fetch=fetch,ctx?:OperationContext):Promise<AvailableRelease> {
  return withOperation('request',15000,ctx,async op=>{
  const response=await request('https://registry.npmjs.org/%40ivan-boss%2Fhse-harness',{signal:op.signal,redirect:'error'});
  if(!response.ok)throw new Error('Реестр npm временно недоступен');
  const text=await response.text();if(text.length>2_000_000)throw new Error('Слишком большой ответ npm');
  const metadata=JSON.parse(text),version=metadata?.['dist-tags']?.latest;
  if(!stableVersion(version))throw new Error('npm latest не указывает на стабильную версию');
  const pkg=metadata?.versions?.[version],integrity=pkg?.dist?.integrity;
  if(pkg?.name!==PACKAGE_NAME||pkg?.version!==version||typeof integrity!=='string'||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity))throw new Error('Версия npm ещё не доступна или её метаданные некорректны');
  const url=new URL(pkg.dist.tarball);
  if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.username||url.password||url.port)throw new Error('Архив обновления вне официального реестра');
  return {version,integrity};
  });
}
