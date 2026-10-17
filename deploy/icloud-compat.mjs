import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

// Version-bound compatibility for an immutable 0.2.0 worker. Patch the query
// adapter in memory, without modifying the verified release or its inventory.
// Newer workers use the fixed source adapter and do not install this override.
export function installCalDAVCollectionCompatibility(Collection) {
  if (typeof Collection?.prototype?.objects !== 'function') throw new Error('Unsupported CalDAV adapter for 0.2.0 compatibility');
  Collection.prototype.objects = function (urls) {
    const base = new URL(this.calendar.url);
    return this.client.fetchCalendarObjects({calendar:this.calendar,objectUrls:urls,urlFilter:value=>{
      try {
        const url = new URL(value,base);
        return url.origin===base.origin && url.pathname.startsWith(base.pathname) && url.pathname!==base.pathname && !url.pathname.endsWith('/') && !url.search && !url.hash && !url.username && !url.password;
      } catch { return false; }
    }});
  };
}

if (process.env.HSE_ICLOUD_COLLECTION_COMPAT==='1' && process.env.HSE_RELEASE_VERSION==='0.2.0') {
  // The override is useful only for isolated smoke tests; the real worker uses
  // its own immutable module so ESM cache identity matches the application.
  const moduleURL = process.env.HSE_ICLOUD_COMPAT_MODULE ?? new URL('./calendar/providers/caldav.js',pathToFileURL(resolve(process.argv[1]))).href;
  if (new URL(moduleURL).protocol!=='file:') throw new Error('CalDAV compatibility requires a local adapter');
  const {CalDAVCollection} = await import(moduleURL);
  installCalDAVCollectionCompatibility(CalDAVCollection);
}
