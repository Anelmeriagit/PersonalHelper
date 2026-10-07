/* Точка входа: каркас страницы (гость и аккаунт, выход, переключение разделов, события вкладки).
   Каждый раздел живёт в своём модуле: cashback/, reminders/, wifi.js, agent/. */
import {$} from './util.js';
import {S,api,net,onAuthFail,fresh} from './api.js';
import {dlgConfirm,dlgAlert} from './dialogs.js';
import {hasUnsaved,initCashback,setStatus,stopSave,onVisible as cbVisible,onPage as cbPage,onHidden as cbHidden,discardAll,startSession,finishBoot,toGuest,cbSnapshot,cbNote} from './cashback/index.js';
import {initReminders,remLoad} from './reminders/index.js';
import {initWifi,wifiLoad,wifiClear} from './wifi.js';
import {initAgent,agClear,agLeave,agVisible,agOnPage} from './agent/index.js';
import {initTheme} from './theme-switch.js';
import {initTg,tgVisible,tgClear} from './tglink.js';
import {initWelcome} from './welcome.js';
import {initAccount,accShow,accSetName} from './account.js';

var editBtn=$('editBtn'),loginRoot=$('loginRoot'),mainNav=$('mainNav');

/* ---------- страницы ---------- */
var PAGES={main:{stage:$('stage'),nav:$('navMain')},rem:{stage:$('remStage'),nav:$('navRem')},wifi:{stage:$('wifiStage'),nav:$('navWifi')},agent:{stage:$('agentStage'),nav:$('navAgent')}};
var HASH={'#reminders':'rem','#wifi':'wifi','#agent':'agent'};
function pageFromHash(){return HASH[location.hash]||'main'}
S.page=pageFromHash();
function ui(){mainNav.hidden=false;editBtn.hidden=S.page!=='main';accShow(S.acct)}
function applyPage(){var prev=S.page;S.page=pageFromHash();
  Object.keys(PAGES).forEach(function(k){var p=PAGES[k],on=k===S.page;
    p.stage.hidden=!S.loggedIn||!on;p.nav.classList.toggle('on',on);
    if(on)p.nav.setAttribute('aria-current','page');else p.nav.removeAttribute('aria-current')});
  $('remAcct').hidden=!S.acct;$('remGuest').hidden=S.acct;$('wifiGuest').hidden=S.acct;$('agentGuest').hidden=S.acct;
  document.body.classList.toggle('pw',S.page==='wifi');
  editBtn.hidden=!S.loggedIn||S.page!=='main';
  if(prev!==S.page)window.scrollTo(0,0);
  if(S.page!=='wifi')wifiClear();
  if(S.page!=='rem')tgClear();
  /* переход на раздел: данные грузятся всегда (REFRESH_MS ограничивает только возврат на вкладку); привязка Telegram приходит в ответе remLoad */
  if(S.acct&&S.page==='rem')remLoad();
  if(S.acct&&S.page==='wifi')wifiLoad();
  if(S.loggedIn&&S.page==='main'&&prev!=='main')cbPage();
  agOnPage()}

/* ---------- аккаунт и гость ----------
   Без аккаунта сайт открывается в гостевом режиме: разделы работают, данные лежат в браузере (js/local.js), на сервер не уходят.
   Вход только через Google (кнопка в шапке: обычная ссылка, после возврата сайт открывается заново). */
var GUEST_END='Сессия закончилась: вы в гостевом режиме. Правки сохранены в этом браузере. Чтобы вернуться в аккаунт, войдите через Google.';
/* кнопка «Войти через Google» в предложениях гостю (копия кнопки из шапки) */
function gButtons(){Array.prototype.forEach.call(document.querySelectorAll('[data-gbtn]'),function(box){
  var b=$('gBtn').cloneNode(true);b.removeAttribute('id');b.hidden=false;box.appendChild(b)})}
/* открыть разделы: j — ответ GET /api/data (с сервера или из браузера) */
function openApp(j){startSession(j);S.loggedIn=true;loginRoot.innerHTML='';ui();applyPage();finishBoot()}
function openAcct(j){S.acct=true;accSetName(j&&j.name);openApp(j)}
function openGuest(){S.acct=false;return api('GET','/api/data').then(function(r){return r.json()}).then(openApp)}
/* из аккаунта в гостя: выход, конец сессии (401), удаление аккаунта. snap — данные аккаунта, которые заменят гостевые (null: гостевые остаются как были) */
function toGuestMode(snap,notice){S.acct=false;S.at={};wifiClear();agClear();tgClear();toGuest(snap);ui();applyPage();if(notice)cbNote(notice)}
function boot(){net('GET','/api/data').then(function(r){
  if(r.status===401)return openGuest();
  if(!r.ok)throw 0;
  return r.json().then(openAcct)
}).catch(function(){loginRoot.innerHTML='<p class=\"empty\">Не удалось загрузить данные. Обновите страницу.</p>'})}
function logout(){(hasUnsaved()?dlgConfirm('Есть несохранённые изменения. Выйти без сохранения?'):Promise.resolve(true)).then(function(ok){if(!ok)return;discardAll();
  /* данные аккаунта остаются в браузере и становятся гостевыми: свежая копия берётся до выхода, пока сессия жива */
  api('GET','/api/data').then(function(r){return r.ok?r.json():null}).catch(function(){return null}).then(function(j){
    function leave(){toGuestMode(j&&j.data?{months:j.data.months,custom:j.data.custom}:null)}
    api('POST','/api/auth',{action:'logout'}).then(leave,leave)})})}

/* ---------- события вкладки ---------- */
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='visible'){
    /* возврат на вкладку: каждый раздел обновляется не чаще раза в REFRESH_MS (api.js); ожидающая привязка Telegram проверяется сразу */
    cbVisible();
    if(S.acct&&S.page==='rem'){if(!fresh('rem'))remLoad();tgVisible()}
    if(S.acct&&S.page==='wifi'&&!fresh('wifi'))wifiLoad();
    agVisible()
  }else{cbHidden();agLeave()}});
window.addEventListener('pagehide',function(){cbHidden();agLeave()});
window.addEventListener('hashchange',applyPage);
/* логотип не загрузился -> буква банка (без инлайнового onerror, чтобы работал строгий CSP) */
document.addEventListener('error',function(e){var t=e.target,b=t&&t.tagName==='IMG'&&t.parentNode;if(b&&(b.classList.contains('badge')||b.classList.contains('mb'))){b.classList.add('nologo');t.remove()}},true);

/* возврат со входа через Google: при отказе или ошибке сервер ведёт на /?gerr=<код>; текст берётся по коду из этого списка, из адреса ничего не выводится; параметр из адреса убирается всегда, для неизвестного кода сообщения нет */
var GERR={off:'Вход через Google пока не настроен.',denied:'Вход через Google отменён.',state:'Вход не удался: время вышло. Нажмите «Войти через Google» ещё раз.',rate:'Слишком много попыток входа. Попробуйте позже.',full:'Достигнут лимит пользователей.',fail:'Не удалось войти через Google. Попробуйте позже.'};
function googleBack(){var m=/[?&]gerr=([^&#]*)/.exec(location.search);if(!m)return;
  history.replaceState(null,'',location.pathname+location.hash);
  if(Object.prototype.hasOwnProperty.call(GERR,m[1]))dlgAlert(GERR[m[1]])}

onAuthFail(function(){if(S.acct)toGuestMode(cbSnapshot(),GUEST_END)});
initCashback();initReminders();initWifi();initAgent();initTheme();initTg(remLoad);initWelcome();
initAccount({logout:logout,tg:function(){if(S.page==='rem')remLoad()},gone:function(){discardAll();toGuestMode(null);dlgAlert('Аккаунт удалён.')}});
gButtons();boot();
googleBack();
