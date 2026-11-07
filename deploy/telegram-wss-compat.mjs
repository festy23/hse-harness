import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

export function installTelegramFactoryCompatibility(Source, createClient) {
  const original = Source.prototype.connect;
  Source.prototype.connect = function (...args) {
    this.options = { ...this.options, createClient: this.options?.createClient ?? createClient };
    return original.apply(this, args);
  };
}

if (process.env.HSE_RELEASE_VERSION === '0.2.1' && process.env.HSE_TELEGRAM_PROXY_FILE) {
  const entry = resolve(process.argv[1]),
    root = dirname(dirname(entry));
  const module = (name) => import(pathToFileURL(join(root, name)).href);
  const { TelegramSource } = await module('dist/telegram.js');
  const { secret } = await module('dist/config.js');
  const { TelegramClient } = await module('node_modules/teleproto/index.js');
  const { StringSession } = await module('node_modules/teleproto/sessions/index.js');
  const { PromisedWebSockets } = await module(
    'node_modules/teleproto/extensions/PromisedWebSockets.js',
  );
  const require = createRequire(join(root, 'package.json'));
  const { HttpsProxyAgent } = require('https-proxy-agent'),
    WebSocket = require('ws');
  const config = JSON.parse(await readFile(process.env.HSE_TELEGRAM_PROXY_FILE, 'utf8'));
  const proxy = new URL(`http://${config.host}:${config.httpPort}`);
  proxy.username = config.username;
  proxy.password = config.password;
  PromisedWebSockets.webSocketImpl = class extends WebSocket {
    constructor(url, protocol) {
      super(url, protocol, { agent: new HttpsProxyAgent(proxy), handshakeTimeout: 10000 });
    }
  };
  installTelegramFactoryCompatibility(TelegramSource, (saved) => {
    const client = new TelegramClient(
      new StringSession(saved),
      Number(secret('TELEGRAM_API_ID')),
      secret('TELEGRAM_API_HASH'),
      { networkSocket: PromisedWebSockets, connectionRetries: 3, reconnectRetries: 3, timeout: 15 },
    );
    client.setLogLevel('none');
    return client;
  });
}
