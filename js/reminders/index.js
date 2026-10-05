/* «Напоминания»: загрузка с сервера и предупреждение «Telegram не привязан». Списки и форма — в lists.js, привязка — в ../tglink.js */
import {$} from '../util.js';
import {api,authFail} from '../api.js';
import {R} from './state.js';
import {listsRender,initLists} from './lists.js';

var remMsg=$('remMsg'),remWarn=$('remWarn');
function remSync(){if(!R.rem)return;
  remWarn.hidden=!!R.rem.linked;
  if(!R.rem.linked)remWarn.innerHTML='<p>Telegram не привязан: напоминания будут храниться, но приходить не будут. Привяжите Telegram в блоке выше.</p>';
  listsRender()}
export function remLoad(){api('GET','/api/reminders').then(function(r){if(r.status===401){authFail();return}if(!r.ok)throw 0;
  return r.json().then(function(j){R.rem=j;remSync()})}).catch(function(){remMsg.textContent='Не удалось загрузить напоминания. Обновите страницу.'})}

export function initReminders(){
  R.sync=remSync;R.load=remLoad;
  initLists();
}
