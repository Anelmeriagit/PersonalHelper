/* Точка входа: каркас страницы (гость и аккаунт, выход, переключение разделов, события вкладки).
   Каждый раздел живёт в своём модуле: cashback/, reminders/, wifi.js, agent/. */
import {$,ls,lset,ldel,nrm} from './util.js';
import {S,api,net,onAuthFail,fresh} from './api.js';
import {dlgConfirm,dlgAlert} from './dialogs.js';
import {hasUnsaved,initCashback,setStatus,stopSave,onVisible as cbVisible,onPage as cbPage,onHidden as cbHidden,discardAll,startSession,finishBoot,toGuest,cbSnapshot,cbNote,pairChanged,nameChanged} from './cashback/index.js';
import {initReminders,remLoad,remPair} from './reminders/index.js';
import {initWifi,wifiLoad,wifiClear,wifiForget,wifiSnapshot} from './wifi.js';
import {initAgent,agClear,agLeave,agVisible,agOnPage,agSnapshot,agPending} from './agent/index.js';
import {initTheme} from './theme-switch.js';
import {initTg,tgVisible,tgClear} from './tglink.js';
import {initWelcome} from './welcome.js';
import {initAccount,accShow,accSetName} from './account.js';
import {guestSetAg,guestSetWf} from './local.js';
import {mergeGuest} from './merge.js';

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
  $('remAcct').hidden=!S.acct;$('remGuest').hidden=S.acct;
  document.body.classList.toggle('pw',S.page==='wifi');
  editBtn.hidden=!S.loggedIn||S.page!=='main';
  if(prev!==S.page)window.scrollTo(0,0);
  if(S.page!=='wifi')wifiClear();
  if(S.page!=='rem')tgClear();
  /* переход на раздел: данные грузятся всегда (REFRESH_MS ограничивает только возврат на вкладку); привязка Telegram приходит в ответе remLoad */
  if(S.acct&&S.page==='rem')remLoad();
  if(S.loggedIn&&S.page==='wifi')wifiLoad();
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
/* вход в аккаунт: при первом входе в этом браузере гостевые данные сливаются в аккаунт (merge.js), затем разделы открываются уже с итоговым кэшбэком */
var MERGED='Данные из гостевого режима добавлены в аккаунт.';
function openAcct(j){S.acct=true;accSetName(j&&j.name);
  mergeGuest(j).then(function(m){openApp(m&&m.j||j);if(m)cbNote(MERGED);joinTry()})}
function openGuest(){S.acct=false;return api('GET','/api/data').then(function(r){return r.json()}).then(function(j){openApp(j);joinTry()})}
/* из аккаунта в гостя: выход, конец сессии (401), удаление аккаунта. snap — данные аккаунта, которые заменят гостевые: {cb, ag, wf}, каждая часть отдельно
   (cb — кэшбэк; ag — строки агента; wf — сеть WiFi, null: у аккаунта сети нет, гостевая удаляется); часть без значения (null, у wf ещё и undefined) оставляет гостевые данные как были; snap=null — все остаются как были */
function toGuestMode(snap,notice){var g=snap||{};S.acct=false;S.at={};wifiForget();agClear();tgClear();
  if(g.ag)guestSetAg(g.ag);
  if(g.wf!==undefined)guestSetWf(g.wf);
  toGuest(g.cb);ui();applyPage();if(notice)cbNote(notice)}
function boot(){net('GET','/api/data').then(function(r){
  if(r.status===401)return openGuest();
  if(!r.ok)throw 0;
  return r.json().then(openAcct)
}).catch(function(){loginRoot.innerHTML='<p class=\"empty\">Не удалось загрузить данные. Обновите страницу.</p>'})}
function logout(){(hasUnsaved()?dlgConfirm('Есть несохранённые изменения. Выйти без сохранения?'):Promise.resolve(true)).then(function(ok){if(!ok)return;discardAll();
  /* данные аккаунта остаются в браузере и становятся гостевыми: свежие копии берутся до выхода, пока сессия жива; несохранённая правка агента (её нет на сервере) берётся из памяти */
  var pend=agPending();
  Promise.all([fetchJ('/api/data'),fetchJ('/api/agent'),fetchJ('/api/wifi')]).then(function(a){
    var d=a[0],w=a[2],snap={cb:d&&d.data?{months:d.data.months,custom:d.data.custom}:null,ag:pend||(a[1]&&a[1].rows)||null,wf:w?(w.configured?w:null):undefined};
    function leave(){toGuestMode(snap)}
    api('POST','/api/auth',{action:'logout'}).then(leave,leave)})})}
/* один GET раздела: разобранный ответ или null, если не вышло */
function fetchJ(u){return api('GET',u).then(function(r){return r.ok?r.json():null}).catch(function(){return null})}

/* ---------- события вкладки ---------- */
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='visible'){
    /* возврат на вкладку: каждый раздел обновляется не чаще раза в REFRESH_MS (api.js); ожидающая привязка Telegram проверяется сразу */
    cbVisible();
    if(S.acct&&S.page==='rem'){if(!fresh('rem'))remLoad();tgVisible()}
    if(S.loggedIn&&S.page==='wifi'&&!fresh('wifi'))wifiLoad();
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

/* соединение аккаунтов по ссылке /?join=<токен> (сервер: notes/account.md): адрес сразу очищается, токен ждёт в localStorage (`pj`, сутки, как сама ссылка),
   чтобы пережить вход через Google; соединяет запрос pair-join, как только есть аккаунт. Текст ошибок приходит с сервера. */
var PJ='pj',PJ_AGE=24*60*60*1000,PJ_RE=/^[A-Za-z0-9_-]{22}$/;
var PJ_GUEST='Чтобы соединить аккаунты, войдите через Google. Ссылка сохранена на сутки: после входа аккаунты соединятся сами.';
var joinAsked=false;
function dropParam(n){var q=location.search.replace(/^\?/,'').split('&').filter(function(p){return p&&p.split('=')[0]!==n}).join('&');
  history.replaceState(null,'',location.pathname+(q?'?'+q:'')+location.hash)}
function joinStore(){var m=/[?&]join=([^&#]*)/.exec(location.search);if(!m)return;dropParam('join');
  if(PJ_RE.test(m[1]))lset(PJ,JSON.stringify({t:m[1],at:Date.now()}))}
function joinToken(){try{var d=JSON.parse(ls(PJ));return d&&typeof d.t==='string'&&PJ_RE.test(d.t)&&Date.now()-d.at<PJ_AGE?d.t:null}catch(e){return null}}
/* окно сообщений одно на сайт: если там уже что-то показано (например, ошибка входа), ждём его закрытия */
function whenFree(fn){var d=$('dlg');if(!d.open){fn();return}d.addEventListener('close',function h(){d.removeEventListener('close',h);fn()})}
function joinTry(){var t=joinToken();if(!t){ldel(PJ);return}
  if(!S.acct){if(!joinAsked){joinAsked=true;whenFree(function(){dlgAlert(PJ_GUEST)})}return}
  net('POST','/api/auth',{action:'pair-join',token:t}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){
    if(r.status===401)return;
    if(r.status===429){whenFree(function(){dlgAlert(j.error||'Слишком часто. Попробуйте позже.')});return}
    ldel(PJ);
    if(r.ok&&j.partner&&j.partner.linked){pairChanged(true);remPair();whenFree(function(){dlgAlert('Ваш аккаунт соединён с аккаунтом '+(nrm(j.partner.name)||'Helper User')+'.')})}
    else whenFree(function(){dlgAlert(typeof j.error==='string'&&j.error?j.error:'Не удалось соединить аккаунты. Попробуйте позже.')})})
  }).catch(function(){whenFree(function(){dlgAlert('Нет связи с сервером. Откройте ссылку ещё раз.')})})}

onAuthFail(function(){if(S.acct)toGuestMode({cb:cbSnapshot(),ag:agSnapshot(),wf:wifiSnapshot()},GUEST_END)});
initCashback();initReminders();initWifi();initAgent();initTheme();initTg(remLoad);initWelcome();
initAccount({logout:logout,tg:function(){if(S.page==='rem')remLoad()},gone:function(){discardAll();toGuestMode(null);dlgAlert('Аккаунт удалён.')},pair:function(){pairChanged(false);remPair()},name:nameChanged});
joinStore();
gButtons();boot();
googleBack();
