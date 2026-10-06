import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { modelRuntime, resourceLoader, instructions } from './pi.js';
import { directories } from './config.js';

async function main():Promise<void> {
  await directories();const id=process.env.STUDY_EVAL_MODEL;
  if(!id)throw new Error('Укажите STUDY_EVAL_MODEL из setup models. Eval использует подписку и не отправляет внешние сообщения.');
  const runtime=await modelRuntime();if(!runtime.isUsingSubscription('openai'))throw new Error('Нужен setup pi');
  const model=runtime.getModel('openai',id);if(!model)throw new Error('Модель не найдена');
  const dir=await mkdtemp(join(tmpdir(),'study-eval-'));const manager=SessionManager.create(dir);
  // Force this short fixture through real compaction; production retains its normal token budget.
  const {session}=await createAgentSession({cwd:dir,modelRuntime:runtime,model,sessionManager:manager,resourceLoader:resourceLoader(instructions),noTools:'builtin',tools:[],settingsManager:SettingsManager.inMemory({compaction:{enabled:true,keepRecentTokens:1}})});
  try {
    await session.prompt('Контрольные данные: работа A по Тестированию, срок 2026-10-20 15:00 +03:00. Затем преподаватель перенес A на 2026-10-23 18:00 +03:00. Владелец сообщил: A сделана, но не сдана. Работа B по НИС: сдать 2026-10-25, без времени. Работа C отменена. Запомни актуальное положение дел. Ответь только «Принято», без повторения данных.');
    const first=session.messages.at(-1);
    if(first?.role!=='assistant'||first.stopReason==='error'||first.stopReason==='aborted')throw new Error(first?.role==='assistant'?first.errorMessage??'Eval: модель не завершила ответ':'Eval: нет ответа модели');
    await session.compact('Сохрани актуальные задания, переносы, источники, статусы и правило даты без времени.');
    session.dispose();
    const resumed=await createAgentSession({cwd:dir,modelRuntime:runtime,model,sessionManager:SessionManager.open(manager.getSessionFile()!),resourceLoader:resourceLoader(instructions),noTools:'builtin',tools:[]});
    try {
      await resumed.session.prompt('Верни только JSON: {"A":{"deadline":"ISO с поясом","status":"done|submitted"},"B":{"deadline":"ISO с поясом"},"C":{"status":"cancelled"}}. Учитывай перенос и личное правило даты без часа.');
      const last=resumed.session.messages.at(-1);
      if(last?.role!=='assistant'||last.stopReason==='error'||last.stopReason==='aborted')throw new Error(last?.role==='assistant'?last.errorMessage??'Eval: модель не завершила ответ':'Eval: нет ответа модели');
      const answer=resumed.session.getLastAssistantText()??'';
      const match=answer.match(/\{[\s\S]*\}/);if(!match)throw new Error('Eval: ответ не JSON');
      const data=JSON.parse(match[0]);
      if(+new Date(data.A.deadline)!==Date.parse('2026-10-23T18:00:00+03:00')||data.A.status!=='done'||+new Date(data.B.deadline)!==Date.parse('2026-10-25T00:00:00+03:00')||data.C.status!=='cancelled')throw new Error('Eval FAILED: compaction/restart потерял контрольный факт. Не расширять память автоматически; сначала разобрать ошибку.');
      console.log('Eval PASS: перенос, статус, отмена и дата без времени сохранились после compaction + restart. Это ограниченный контрольный сценарий, а не гарантия полноты.');
    }finally{resumed.session.dispose();}
  }finally{session.dispose();await rm(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Eval failed');process.exitCode=1;});
