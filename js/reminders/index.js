/* «Напоминания»: загрузка с сервера и предупреждение «Telegram не привязан». Списки и форма — в lists.js, привязка — в ../tglink.js.
   Ответ GET /api/reminders несёт и состояние привязки (linked, username): блок «Telegram» берёт его оттуда (tgApply), отдельного запроса при входе на страницу нет. */
import {$} from '../util.js';
import {api,S,authFail,stamp} from '../api.js';
import {tgApply} from '../tglink.js';
import {R} from './state.js';
import {listsRender,initLists} from './lists.js';

var remMsg=$('remMsg'),remWarn=$('remWarn');
function remSync(){if(!R.rem)return;
  remWarn.hidden=!!R.rem.linked;
  if(!R.rem.linked)remWarn.innerHTML='<p>Telegram не привязан: напоминания будут храниться, но приходить не будут. Привяжите Telegram в блоке выше.</p>';
  listsRender()}
export function remLoad(){api('GET','/api/reminders').then(function(r){if(r.status===401){authFail();return}if(!r.ok)throw 0;
  return r.json().then(function(j){stamp('rem');R.rem=j;remSync();if(S.loggedIn&&S.page==='rem')tgApply(j)})}).catch(function(){remMsg.textContent='Не удалось загрузить напоминания. Обновите страницу.'})}

/* связь аккаунтов изменилась (соединили или разорвали): общие напоминания устарели; на странице «Напоминания» список грузится заново */
export function remPair(){delete S.at.rem;if(R.rem){delete R.rem.shared;remSync()}if(S.acct&&S.page==='rem')remLoad()}

export function initReminders(){
  R.sync=remSync;R.load=remLoad;
  initLists();
}
