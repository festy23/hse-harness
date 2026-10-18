import {mkdir,rm,open,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {findNpm} from '../../runtime/executable.mjs';

const root=resolve('data/e2e/latest/updates');
const withNpm=process.argv.includes('--with-npm');
await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true});
const abort=new AbortController(),stop=()=>abort.abort();
process.once('SIGINT',stop);process.once('SIGTERM',stop);
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>! /^(TELEGRAM_|YANDEX_|ICLOUD_|GOOGLE_|OPENAI_|ANTHROPIC_|DEEPSEEK_|STUDY_)/.test(key)&&!['NODE_OPTIONS','NODE_PATH'].includes(key)));
Object.assign(env,{HSE_UPDATES_E2E_ARTIFACTS:root,HSE_UPDATES_E2E_COMPILED:'1'});
const stages=[];

async function run(name,logName,args,timeout){
  console.log(`RUN ${name}`);
  const started=Date.now(),log=await open(join(root,logName),'w');
  let child,timer,killTimer,cancelled=false;
  const terminate=()=>{
    if(cancelled)return;cancelled=true;
    const signal=s=>{try{if(child?.pid)process.kill(-child.pid,s);}catch(error){if(error.code!=='ESRCH')throw error;}};
    signal('SIGTERM');killTimer=setTimeout(()=>signal('SIGKILL'),2000);
  };
  try{
    abort.signal.throwIfAborted();
    child=spawn(process.execPath,args,{env,cwd:resolve('.'),detached:true,stdio:['ignore',log.fd,log.fd]});
    abort.signal.addEventListener('abort',terminate,{once:true});
    timer=setTimeout(terminate,timeout);
    const outcome=await new Promise((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));});
    if(cancelled||outcome.code!==0)throw Error(`${name}: ${cancelled?'отменено или истёк таймаут':`код ${outcome.code??outcome.signal}`}. Лог: ${join(root,logName)}`);
    stages.push({name,log:logName,passed:true,durationMs:Date.now()-started});console.log(`PASS ${name}`);
  }catch(error){stages.push({name,log:logName,passed:false,durationMs:Date.now()-started});throw error;}
  finally{clearTimeout(timer);clearTimeout(killTimer);abort.signal.removeEventListener('abort',terminate);await log.close();}
}

let failure;
try{
  await run('Команды и кнопки в настоящем compiled worker','worker.log',['--import',import.meta.resolve('tsx'),'--test',resolve('test/worker-telegram-update.test.ts')],90000);
  await run('Ежедневные напоминания, сохранение настроек и повторы','policy.log',['--import',import.meta.resolve('tsx'),'--test',resolve('test/telegram-updates.test.ts'),resolve('test/update-settings.test.ts')],60000);
  if(withNpm)await run('Реальные npm-пакеты и переключение supervisor','npm.log',[await findNpm(),'run','test:updates'],600000);
}catch(error){failure=error;process.exitCode=1;}
finally{
  process.off('SIGINT',stop);process.off('SIGTERM',stop);
  const npmLog=withNpm?await readFile(join(root,'npm.log'),'utf8').catch(()=>''):'';
  const pause=npmLog.match(/Measured local process switch pause: (\d+)ms/);
  const result={success:!failure,at:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,withNpm,stages,switchPauseMs:pause?Number(pause[1]):undefined,
    scope:{ui:'Real compiled daemon, Telegram/registry/installer/protocol-driver fixtures; reaches awaiting-apply.',reminders:'Deterministic virtual clock, no 24-hour wall-clock wait.',npm:withNpm?'Real npm installs and real supervisor switching two complete archives with a protocol worker fixture.':'Not run; use --with-npm.'},...(failure?{failure:String(failure.message)}:{})};
  await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
  const lines=['# Локальная проверка /updates','',`Результат: ${failure?'FAIL':'PASS'}. Node ${process.version}, ${process.platform}/${process.arch}.`,'',
    'Запускается настоящий собранный бот. Telegram, учебные источники и установка в UI-сценарии имитируются; учебные аккаунты не подключаются. UI-сценарий заканчивается на передаче обновления supervisor (`awaiting-apply`).',
    'Ежедневные напоминания проверяются виртуальным временем.',
    withNpm?'Отдельно запущен настоящий npm и supervisor с двумя полными архивами проекта; worker в этом тесте протокольный. Это отдельная проверка смены версии, а не единый живой Telegram → npm → новый бот сценарий.':'Реальный npm-переход можно проверить командой `npm run test:e2e:updates -- --with-npm`.','',
    ...stages.map(stage=>`- ${stage.passed?'PASS':'FAIL'} — ${stage.name} ([лог](${stage.log})).`),''];
  if(pause)lines.push(`Измеренная пауза переключения: ${pause[1]} мс.`,'');
  if(failure)lines.push(String(failure.message),'');
  for(const mode of ['manual','automatic']){
    const dialogue=await readFile(join(root,mode,'dialogue.json'),'utf8').then(JSON.parse).catch(()=>[]);
    lines.push(`## ${mode==='manual'?'Ручное обновление':'Включение и выключение автообновления'}`,'');
    for(const item of dialogue){
      if(item.actor==='bot'&&!/Обновления HSE HARNESS|Автообновление|Доступна новая|запускаю обновление|устарела/i.test(item.text))continue;
      lines.push(`**${item.actor==='owner'?'Пользователь':'Бот'}**`,'',...item.text.split('\n').map(line=>`> ${line}`),'');
      if(item.buttons?.length)lines.push(`Кнопки: ${item.buttons.map(text=>`[${text}]`).join(' ')}`,'');
    }
  }
  await writeFile(join(root,'report.md'),lines.join('\n')+'\n');
  console.log(`Artifacts: ${root}`);
  if(failure)console.error(failure.message);
}
