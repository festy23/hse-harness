import { Api, type TelegramClient } from 'teleproto';
import { getPeerId } from 'teleproto/Utils.js';
import bigInt from 'big-integer';
import type { TelegramChat } from './config.js';

type Reference={kind:'id'|'username'|'invite';value:string};
const username=/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;
const invite=/^[a-zA-Z0-9_-]{1,200}$/;
const invalid=()=>new Error('Укажи ID группы/канала, @username или ссылку t.me на чат либо сообщение');
const inaccessible=()=>new Error('Нет доступа к этому чату: личный Telegram-аккаунт должен уже состоять в нём. Автоматическое вступление отключено');

export function parseTelegramChatReference(input:string):Reference {
  const value=input.trim();
  if(!value||value.length>500)throw invalid();
  if(/^-?\d{1,20}$/.test(value)&&BigInt(value)!==0n)return {kind:'id',value:BigInt(value).toString()};
  if(username.test(value.replace(/^@/,'')))return {kind:'username',value:value.replace(/^@/,'').toLowerCase()};
  let url:URL;
  try {url=new URL(/^(?:t\.me|telegram\.me)\//i.test(value)?'https://'+value:value);}catch{throw invalid();}
  if(url.username||url.password||url.port)throw invalid();
  if(url.protocol==='tg:') {
    if(url.hostname==='resolve'&&username.test(url.searchParams.get('domain')??''))return {kind:'username',value:url.searchParams.get('domain')!.toLowerCase()};
    if(url.hostname==='join'&&invite.test(url.searchParams.get('invite')??''))return {kind:'invite',value:url.searchParams.get('invite')!};
    throw invalid();
  }
  if(url.protocol!=='https:'||!['t.me','telegram.me'].includes(url.hostname))throw invalid();
  const path=url.pathname.replace(/\/$/,'');
  const privatePost=path.match(/^\/c\/(\d{1,16})\/\d+(?:\/\d+)?$/);
  if(privatePost&&BigInt(privatePost[1]!)>0n)return {kind:'id',value:getPeerId(new Api.PeerChannel({channelId:bigInt(privatePost[1]!)}))};
  const invitation=path.match(/^\/(?:\+|joinchat\/)([a-zA-Z0-9_-]{1,200})$/);
  if(invitation)return {kind:'invite',value:invitation[1]!};
  const publicPost=path.match(/^\/(?:s\/)?([a-zA-Z][a-zA-Z0-9_]{3,31})(?:\/\d+(?:\/\d+)?)?$/);
  if(publicPost&&!['joinchat','share','addstickers','proxy','socks','login'].includes(publicPost[1]!.toLowerCase()))return {kind:'username',value:publicPost[1]!.toLowerCase()};
  throw invalid();
}

/** Resolve and probe existing membership only. This module never joins or sends. */
export async function resolveTelegramChat(client:TelegramClient,reference:string):Promise<{chat:TelegramChat;peer:Api.TypeInputPeer}> {
  const ref=parseTelegramChatReference(reference);
  const dialogs=await client.getDialogs({limit:undefined});
  const members=dialogs.flatMap(d=>{
    const e=d.entity;
    return (e instanceof Api.Chat&&!e.left&&!e.deactivated&&!e.migratedTo)||(e instanceof Api.Channel&&!e.left)?[e as Api.Chat|Api.Channel]:[];
  });
  let matches:(Api.Chat|Api.Channel)[];
  if(ref.kind==='id')matches=members.filter(e=>getPeerId(e)===ref.value||(BigInt(ref.value)>0n&&e.id.toString()===ref.value));
  else {
    let entity;
    if(ref.kind==='invite') {
      let result;
      try {result=await client.invoke(new Api.messages.CheckChatInvite({hash:ref.value}));}
      catch {throw new Error('Пригласительная ссылка недействительна или недоступна. Передай числовой ID чата');}
      if(!(result instanceof Api.ChatInviteAlready))throw inaccessible();
      entity=result.chat;
    } else {
      entity=members.find(e=>e instanceof Api.Channel&&(e.username?.toLowerCase()===ref.value||e.usernames?.some(u=>u.active&&u.username.toLowerCase()===ref.value)));
      if(!entity) {
        try {entity=await client.getEntity('@'+ref.value);}catch{throw new Error('Telegram-чат по этой ссылке не найден; проверь ссылку или передай ID');}
      }
    }
    if(!(entity instanceof Api.Chat||entity instanceof Api.Channel))throw new Error('Источник должен быть группой или каналом, а не личным диалогом');
    matches=members.filter(e=>getPeerId(e)===getPeerId(entity));
  }
  matches=[...new Map(matches.map(e=>[getPeerId(e),e])).values()];
  if(matches.length>1)throw new Error('Неоднозначный ID: передай полный Telegram ID с префиксом -100 либо ссылку');
  const entity=matches[0];
  if(!entity)throw inaccessible();
  const peer=await client.getInputEntity(entity);
  try {await client.getMessages(peer,{limit:1});}
  catch {throw new Error('Не удалось прочитать чат. Проверь доступ личного Telegram-аккаунта и повтори попытку');}
  return {chat:{id:getPeerId(entity),title:entity.title,allowQuestions:false},peer};
}
