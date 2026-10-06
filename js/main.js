/* Точка входа: каркас страницы (вход и выход, переключение разделов, события вкладки).
   Каждый раздел живёт в своём модуле: cashback/, reminders/, wifi.js, agent/. */
import {$} from './util.js';
import {S,api,onAuthFail} from './api.js';
import {dlgConfirm,dlgAlert} from './dialogs.js';
import {hasUnsaved,initCashback,setStatus,stopSave,onVisible as cbVisible,onHidden as cbHidden,discardAll,loggedOut,startSession,syncEditPressed,finishBoot} from './cashback/index.js';
import {initReminders,remLoad} from './reminders/index.js';
import {initWifi,wifiLoad,wifiClear} from './wifi.js';
import {initAgent,agClear,agLeave,agVisible,agOnPage} from './agent/index.js';
import {initTheme} from './theme-switch.js';
import {initTg,tgLoad,tgClear} from './tglink.js';
import {initWelcome} from './welcome.js';
import {initAccount,accShow,accSetName} from './account.js';

var editBtn=$('editBtn'),loginRoot=$('loginRoot'),mainNav=$('mainNav');

/* ---------- страницы ---------- */
var PAGES={main:{stage:$('stage'),nav:$('navMain')},rem:{stage:$('remStage'),nav:$('navRem')},wifi:{stage:$('wifiStage'),nav:$('navWifi')},agent:{stage:$('agentStage'),nav:$('navAgent')}};
var HASH={'#reminders':'rem','#wifi':'wifi','#agent':'agent'};
function pageFromHash(){return HASH[location.hash]||'main'}
S.page=pageFromHash();
function ui(on){mainNav.hidden=!on;editBtn.hidden=!on||S.page!=='main';accShow(on);if(!on)setStatus('')}
function applyPage(){var prev=S.page;S.page=pageFromHash();
  Object.keys(PAGES).forEach(function(k){var p=PAGES[k],on=k===S.page;
    p.stage.hidden=!S.loggedIn||!on;p.nav.classList.toggle('on',on);
    if(on)p.nav.setAttribute('aria-current','page');else p.nav.removeAttribute('aria-current')});
  document.body.classList.toggle('pw',S.page==='wifi');
  editBtn.hidden=!S.loggedIn||S.page!=='main';
  if(prev!==S.page)window.scrollTo(0,0);
  if(S.page!=='wifi')wifiClear();
  if(S.page!=='rem')tgClear();
  if(S.loggedIn&&S.page==='rem'){remLoad();tgLoad()}
  if(S.loggedIn&&S.page==='wifi')wifiLoad();
  agOnPage()}

/* ---------- вход, регистрация и выход ---------- */
var NICK_RE=/^[a-z0-9][a-z0-9_.-]{2,23}$/;
function showLogin(){var keep=hasUnsaved();stopSave();ui(false);
  Object.keys(PAGES).forEach(function(k){PAGES[k].stage.hidden=true});
  wifiClear();agClear();tgClear();S.loggedIn=false;loggedOut(keep);
  authForm('login',keep,'')}
/* mode: 'login' | 'reg'. Переключатель внизу формы меняет режим и сохраняет введённый никнейм. */
function authForm(mode,keep,nick){var reg=mode==='reg';
  loginRoot.innerHTML='<form class="login" id="lf" novalidate><h2>'+(reg?'Регистрация':'Вход')+'</h2>'+(keep?'<p class="err" role="status">Сессия истекла. Войдите снова: несохранённые изменения остались в этой вкладке.</p>':'')+
    '<div class="f"><label for="u">Никнейм</label><input id="u" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="24" required>'+(reg?'<p class="hint">3–24 символа: латинские буквы, цифры, _ . -</p>':'')+'</div>'+
    '<div class="f"><label for="pw">Пароль</label><input id="pw" type="password" autocomplete="'+(reg?'new-password':'current-password')+'" maxlength="200" required>'+(reg?'<p class="hint">Не короче 8 символов</p>':'')+'</div>'+
    (reg?'<div class="f"><label for="pw2">Повторите пароль</label><input id="pw2" type="password" autocomplete="new-password" maxlength="200" required></div>':'')+
    '<p class="err" id="le" role="alert"></p><button class="done" type="submit">'+(reg?'Создать аккаунт':'Войти')+'</button>'+
    '<p class="alt"><button class="lnk" id="am" type="button">'+(reg?'Уже есть аккаунт? Войти':'Нет аккаунта? Регистрация')+'</button></p></form>';
  $('u').value=nick||'';
  $('am').addEventListener('click',function(){authForm(reg?'login':'reg',false,$('u').value.trim())});
  $('lf').addEventListener('submit',function(ev){ev.preventDefault();
    var u=$('u').value.trim(),pw=$('pw').value,le=$('le'),btn=$('lf').querySelector('.done');
    if(!u||!pw){le.textContent='Введите никнейм и пароль';return}
    if(reg){
      if(!NICK_RE.test(u.toLowerCase())){le.textContent='Никнейм: 3–24 символа, латинские буквы, цифры, _ . -';return}
      if(pw.length<8){le.textContent='Пароль не короче 8 символов';return}
      if(pw!==$('pw2').value){le.textContent='Пароли не совпадают';return}}
    le.textContent='';btn.disabled=true;
    api('POST','/api/auth',{action:reg?'register':'login',user:u,pass:pw}).then(function(r){return r.json().then(function(j){
      if(r.ok)boot();else{le.textContent=j.error||'Ошибка входа';btn.disabled=false}})}).catch(function(){le.textContent='Нет связи с сервером';btn.disabled=false})});
  $('u').focus()}
function logout(){(hasUnsaved()?dlgConfirm('Есть несохранённые изменения. Выйти без сохранения?'):Promise.resolve(true)).then(function(ok){if(!ok)return;discardAll();api('POST','/api/auth',{action:'logout'}).then(showLogin,showLogin)})}
function boot(){api('GET','/api/data').then(function(r){
  if(r.status===401){showLogin();return}
  if(!r.ok)throw 0;
  return r.json().then(function(j){
    accSetName(j&&j.name);var kept=startSession(j);S.loggedIn=true;loginRoot.innerHTML='';ui(true);
    if(kept)syncEditPressed();
    applyPage();finishBoot(kept)})
}).catch(function(){loginRoot.innerHTML='<p class="empty">Не удалось загрузить данные. Обновите страницу.</p>'})}

/* ---------- события вкладки ---------- */
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState==='visible'){
    cbVisible();
    if(S.loggedIn&&S.page==='rem'){remLoad();tgLoad()}
    if(S.loggedIn&&S.page==='wifi')wifiLoad();
    agVisible()
  }else{cbHidden();agLeave()}});
window.addEventListener('pagehide',function(){cbHidden();agLeave()});
window.addEventListener('hashchange',applyPage);
/* логотип не загрузился -> буква банка (без инлайнового onerror, чтобы работал строгий CSP) */
document.addEventListener('error',function(e){var t=e.target,b=t&&t.tagName==='IMG'&&t.parentNode;if(b&&(b.classList.contains('badge')||b.classList.contains('mb'))){b.classList.add('nologo');t.remove()}},true);

onAuthFail(showLogin);
initCashback();initReminders();initWifi();initAgent();initTheme();initTg(remLoad);initWelcome();
initAccount({logout:logout,tg:function(){tgLoad();if(S.page==='rem')remLoad()},gone:function(){discardAll();showLogin();dlgAlert('Аккаунт удалён.')}});
boot();
