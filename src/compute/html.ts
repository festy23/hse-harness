import {convert} from 'html-to-text';
import {OperationError} from '../operations.js';
import type {HtmlComputeJob,HtmlComputeResult} from './jobs.js';

export function htmlCompute(job:HtmlComputeJob):HtmlComputeResult{
  const limit=job.mode==='hse'?1_000_000:job.maxBytes??2_000_000;
  if(!Number.isSafeInteger(limit)||limit<1||limit>8*1024*1024||Buffer.byteLength(job.html)>limit)throw new OperationError('payload-limit','Слишком большой HTML документ');
  if(job.mode==='mail')return {text:convert(job.html,{wordwrap:false,selectors:[{selector:'img',format:'skip'},{selector:'a',options:{ignoreHref:false}}]}),links:[]};
  const links=new Set<string>();
  for(const match of job.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)){
    try{
      const url=new URL(match[1]!,job.baseUrl);
      if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&/^(?:[a-z0-9-]+\.)*hse\.ru$/i.test(url.hostname))links.add(url.href);
    }catch{}
    if(links.size>=200)break;
  }
  return {text:convert(job.html,{wordwrap:false,baseElements:{selectors:['body']}}),links:[...links]};
}
