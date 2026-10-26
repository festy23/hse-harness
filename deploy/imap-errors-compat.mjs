import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function installImapCompatibility(ImapFlow, guard) {
  const connect = ImapFlow.prototype.connect,
    logout = ImapFlow.prototype.logout;
  ImapFlow.prototype.connect = async function (...args) {
    guard(this);
    try {
      return await connect.apply(this, args);
    } catch (error) {
      this.close();
      throw error;
    }
  };
  ImapFlow.prototype.logout = async function (...args) {
    try {
      return await logout.apply(this, args);
    } finally {
      this.close();
    }
  };
}

if (process.env.HSE_RELEASE_VERSION === '0.2.3' && process.env.HSE_IMAP_ERROR_COMPAT === '1') {
  const root = dirname(dirname(resolve(process.argv[1])));
  const { ImapFlow } = await import(
    pathToFileURL(join(root, 'node_modules/imapflow/dist/esm/imap-flow.js')).href
  );
  const { guardImapClient } = await import(new URL('./imap-session.mjs', import.meta.url).href);
  installImapCompatibility(ImapFlow, guardImapClient);
}
