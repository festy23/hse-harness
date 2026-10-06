import { ImapFlow, type MessageStructureObject } from 'imapflow';
import { convert } from 'html-to-text';
import { HISTORY_FROM, hash, type Source } from './domain.js';
import { secret, type Config } from './config.js';
import type { Store } from './store.js';

export function textPart(node:MessageStructureObject|undefined):MessageStructureObject|undefined {
  if(!node || node.disposition?.toLowerCase()==='attachment' || node.dispositionParameters?.filename || node.parameters?.name || node.type==='message/rfc822') return;
  if(node.type==='text/plain' || node.type==='text/html') return node;
  const children=node.childNodes??[];
  return children.map(textPart).find(n=>n?.type==='text/plain') ?? children.map(textPart).find(Boolean);
}
export class MailSource {
  constructor(readonly config:Config,readonly store:Store) {}
  async poll():Promise<void> {
    const client=new ImapFlow({host:'imap.yandex.ru',port:993,secure:true,logger:false,connectionTimeout:20_000,socketTimeout:30_000,auth:{user:secret('YANDEX_ADDRESS'),pass:secret('YANDEX_APP_PASSWORD')}});
    await client.connect();
    try {
      const folders=this.config.folders.length ? this.config.folders : (await client.list()).filter(f=>!['\\Trash','\\Junk','\\Drafts'].includes(f.specialUse??'')).map(f=>f.path);
      for(const folder of folders) {
        const lock=await client.getMailboxLock(folder,{readOnly:true});
        try {
          if(!client.mailbox) throw new Error('Папка не открыта');
          const validity=client.mailbox.uidValidity.toString(),key=`mail:${folder}`;
          const previous=this.store.state.cursors[key]?.split(':');
          const last=previous?.[0]===validity ? Number(previous[1]) : 0;
          const found=await client.search({since:new Date('2026-08-31T00:00:00Z')},{uid:true});
          const ids=(Array.isArray(found)?found:[]).filter(uid=>uid>last).sort((a,b)=>a-b);
          for(let i=0;i<ids.length;i+=25) {
            const messages=await client.fetchAll(ids.slice(i,i+25),{uid:true,envelope:true,internalDate:true,bodyStructure:true},{uid:true});
            for(const m of messages) {
              if(!m.internalDate) throw new Error('IMAP не вернул дату письма');
              if(+new Date(m.internalDate)>=+new Date(HISTORY_FROM)) {
                const part=textPart(m.bodyStructure);
                let text='';
                if(part) {
                  const maxBytes=Number(process.env.STUDY_MAX_TEXT_BYTES??2_000_000);
                  if(!Number.isSafeInteger(maxBytes)||maxBytes<6000)throw new Error('Некорректный STUDY_MAX_TEXT_BYTES');
                  const download=await client.download(String(m.uid),part.part||'1',{uid:true,maxBytes});
                  if(!download.content)throw new Error('Текстовая часть письма не получена; не считать письмо обработанным');
                  if(download.content) {
                    const chunks:Buffer[]=[];
                    for await(const chunk of download.content) chunks.push(Buffer.from(chunk));
                    if(chunks.reduce((n,c)=>n+c.length,0)>=maxBytes)throw new Error('Письмо превышает STUDY_MAX_TEXT_BYTES; не считать его полностью обработанным');
                    text=Buffer.concat(chunks).toString('utf8');
                    if(part.type==='text/html') text=convert(text,{wordwrap:false,selectors:[{selector:'img',format:'skip'},{selector:'a',options:{ignoreHref:false}}]});
                  }
                }
                const envelope=m.envelope;
                const messageId=envelope?.messageId??`${folder}:${validity}:${m.uid}`;
                const s:Source={id:`mail:${hash(messageId)}`,kind:'mail',text:`Тема: ${envelope?.subject??''}\n${text}`,date:new Date(m.internalDate).toISOString(),author:envelope?.from?.map(a=>a.address).join(', '),url:'https://mail.yandex.ru/'};
                await this.store.enqueue([s]);
              }
              this.store.state.cursors[key]=`${validity}:${m.uid}`;await this.store.save();
            }
          }
        } finally {lock.release();}
      }
    } finally {await client.logout().catch(()=>client.close());}
  }
}
