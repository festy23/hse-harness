import type {NpmUpdateState} from '../store.js';
import type {AvailableRelease} from './releases.js';
import {compareVersions} from './releases.js';
import type {UpdateSnapshot} from './runtime.js';

const phases = {
  authorizing:'запрос принят', pending:'ожидает установки', installing:'подготовка и установка',
  'awaiting-apply':'ожидает безопасного переключения', completed:'завершено', failed:'не завершено',
} as const;

/** Pure presentation, shared by command replies and setting changes. */
export function updatePanel(snapshot:UpdateSnapshot,latest:AvailableRelease|undefined,request:NpmUpdateState['request'],registryUnavailable=false):string {
  const lines=[
    'Обновления HSE HARNESS',
    `Текущая версия бота: ${snapshot.runningVersion}`,
    `Последняя версия в npm: ${latest?.version??'не удалось проверить'}`,
    `Автообновление: ${snapshot.automaticUpdates?'🟢 включено':'🔴 выключено'}`,
  ];
  if(snapshot.installedVersion!==snapshot.runningVersion)lines.push(`Установлена, но ещё не запущена: ${snapshot.installedVersion}`);
  if(registryUnavailable)lines.push(latest?'npm сейчас недоступен; показана последняя известная версия.':'npm сейчас недоступен. Настройкой автообновления можно управлять ниже.');
  if(request)lines.push(`Обновление до ${request.version}: ${request.cancelled?'отменено до установки':phases[request.phase]}.`);
  if(snapshot.deferredReason)lines.push(snapshot.deferredReason);
  if(latest&&compareVersions(latest.version,snapshot.runningVersion)>0)lines.push('Доступно обновление. Рекомендую установить актуальную версию.');
  else if(latest&&!registryUnavailable)lines.push('Бот работает на актуальной версии.');
  lines.push(snapshot.automaticUpdates
    ?'Совместимые новые версии устанавливаются автоматически. При необходимости дождусь завершения текущих операций.'
    :'Новые версии устанавливаются по кнопке «Обновить». Пока обновление доступно, напоминаю о нём раз в сутки.');
  return lines.join('\n');
}
