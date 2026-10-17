import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {TelegramClient} from 'teleproto';
import {StringSession} from 'teleproto/sessions/index.js';
import {PromisedWebSockets} from 'teleproto/extensions/PromisedWebSockets.js';
import {Logger,LogLevel} from 'teleproto/extensions/Logger.js';
import {secret} from './config.js';

const require=createRequire(import.meta.url);
/** Shared transport construction; auth/session persistence remains in the caller. */
export async function createTelegramClient(saved:string):Promise<TelegramClient> {
  const file=process.env.TELEGRAM_PROXY_CONFIG??process.env.HSE_TELEGRAM_PROXY_FILE;
  const transport=process.env.TELEGRAM_TRANSPORT??(file?'wss':'tcp');
  if(!['tcp','wss'].includes(transport))throw new Error('TELEGRAM_TRANSPORT должен быть tcp или wss');
  if(transport==='wss'){
    let proxy=process.env.TELEGRAM_HTTP_PROXY??process.env.HTTPS_PROXY;
    if(file){
      const config=JSON.parse(await readFile(file,'utf8'));
      if(typeof config.host!=='string'||!Number.isInteger(config.httpPort)||config.httpPort<1||config.httpPort>65535||typeof config.username!=='string'||typeof config.password!=='string')throw new Error('Некорректная конфигурация Telegram-прокси');
      const url=new URL(`http://${config.host}:${config.httpPort}`);url.username=config.username;url.password=config.password;proxy=url.href;
    }
    if(proxy){
      const url=new URL(proxy);
      if(!['http:','https:'].includes(url.protocol)||url.hash)throw new Error('Для Telegram WSS нужен HTTP/HTTPS-прокси');
      const {HttpsProxyAgent}=require('https-proxy-agent'),WebSocket=require('ws');
      const ProxySocket=class extends WebSocket{constructor(address:string,protocol?:string|string[]){super(address,protocol,{agent:new HttpsProxyAgent(url),handshakeTimeout:15000});}};
      PromisedWebSockets.webSocketImpl=ProxySocket as unknown as NonNullable<typeof PromisedWebSockets.webSocketImpl>;
    }
  }
  const client=new TelegramClient(new StringSession(saved),Number(secret('TELEGRAM_API_ID')),secret('TELEGRAM_API_HASH'),{connectionRetries:3,reconnectRetries:3,timeout:15,baseLogger:new Logger(LogLevel.NONE),...(transport==='wss'?{networkSocket:PromisedWebSockets}:{})});
  // Vendor errors can carry proxy authentication in nested error.options.
  client.setLogLevel(LogLevel.NONE);return client;
}

export async function telegramDeadline<T>(action:Promise<T>,ms:number):Promise<T> {
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([action,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Telegram: подключение не завершилось вовремя; повторю попытку')),ms);})]);}
  finally{clearTimeout(timer);}
}
