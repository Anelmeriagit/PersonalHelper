/* Аккаунт: вход через Google (кнопка в шапке), меню пользователя, окно «Настройки аккаунта», удаление аккаунта.
   Сервер (см. notes/account.md): GET /api/auth?action=google (переход на вход Google, обычная ссылка, без скриптов Google),
   POST /api/auth {action:'me'|'rename'|'delete'}; отвязка Telegram — DELETE /api/tglink. Имя для шапки приходит в GET /api/data (поле name),
   поэтому лишних запросов при входе нет; «me» читается только при открытии окна. */
import {$,esc,nrm,IC} from './util.js';
import {api,authFail} from './api.js';
import {dlgConfirm,dlgAlert} from './dialogs.js';

var DEF='Helper User',WORD='удалить',NAME_MAX=32;
var A={name:'',me:null,gen:0,edit:false,busy:false},cb={logout:function(){},tg:function(){},gone:function(){}};
var uBtn,uMenu,acct,del;

/* ---------- имя в шапке ---------- */
function label(){return A.name||DEF}
function paintName(){var a=$('uName'),b=$('acName');if(a)a.textContent=label();if(b)b.textContent=label()}
export function accSetName(n){A.name=nrm(n).slice(0,NAME_MAX);paintName()}

/* ---------- шапка: вошёл / не вошёл ---------- */
export function accShow(on){$('uWrap').hidden=!on;$('gBtn').hidden=on;
  if(!on){menuClose(false);A.gen++;A.me=null;A.edit=false;A.busy=false;
    if(acct&&acct.open)acct.close();if(del&&del.open)del.close();accSetName('')}}

/* ---------- меню пользователя ---------- */
function menuOpen(first){uMenu.hidden=false;uBtn.setAttribute('aria-expanded','true');
  if(first){var f=uMenu.querySelector('button');if(f)f.focus()}}
function menuClose(focus){if(!uMenu||uMenu.hidden)return;uMenu.hidden=true;uBtn.setAttribute('aria-expanded','false');if(focus)uBtn.focus()}
function menuKey(e){var it=uMenu.querySelectorAll('button'),i=Array.prototype.indexOf.call(it,document.activeElement);
  if(e.key==='ArrowDown'){e.preventDefault();it[(i+1)%it.length].focus()}
  else if(e.key==='ArrowUp'){e.preventDefault();it[(i-1+it.length)%it.length].focus()}}

/* ---------- окно «Настройки аккаунта» ---------- */
function head(){return '<div class="ah"><h2 id="acctH">Настройки аккаунта</h2><button class="x" type="button" data-a="close" aria-label="Закрыть">'+IC.x+'</button></div>'}
function nameRow(){
  if(A.edit)return '<div class="ar"><label class="al" for="acIn">Отображаемое имя</label><input id="acIn" maxlength="'+NAME_MAX+'" autocomplete="nickname" spellcheck="false">'+
    '<p class="ahint">До '+NAME_MAX+' символов. Пустое имя вернёт «'+DEF+'».</p><p class="err" id="acErr" role="alert"></p>'+
    '<div class="acts"><button class="btn" type="button" data-a="cancel">Отмена</button><button class="done" type="button" data-a="save">Сохранить</button></div></div>';
  return '<div class="ar"><div class="al">Отображаемое имя</div><div class="av"><span class="vn" id="acName"></span><button class="btn" type="button" data-a="rename">Изменить</button></div></div>'}
function body(){var m=A.me;
  return head()+nameRow()+
    '<div class="ar"><div class="al">Email</div><div class="av"><span class="vn">'+(m.email?esc(m.email):'<span class="mut">не указан</span>')+'</span></div></div>'+
    '<div class="ar"><div class="al">Account ID</div><div class="av"><code class="vid">'+esc(m.id)+'</code></div></div>'+
    (m.tg?'<div class="ar"><div class="al">Telegram</div><div class="av"><span class="vn">ID '+esc(m.tg.id)+(m.tg.username?'<span class="mut sub">@'+esc(m.tg.username)+'</span>':'')+'</span><button class="btn" type="button" data-a="unlink">Отвязать</button></div></div>':'')+
    '<div class="ar"><div class="al">Соединить аккаунты</div><div class="av"><span class="vn mut">Два аккаунта в один</span><button class="btn" type="button" disabled>Скоро</button></div></div>'+
    '<div class="dz"><button class="done danger" type="button" data-a="del">ПЕРМАНЕНТНОЕ УДАЛЕНИЕ АККАУНТА</button><p>Аккаунт и все его данные будут удалены без возможности восстановления.</p></div>'}
function render(){if(!A.me)return;acct.innerHTML=body();paintName();
  if(A.edit){var i=$('acIn');i.value=A.name;i.focus();i.select();
    i.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();save()}})}}
function focusBtn(a){var b=acct.querySelector('[data-a="'+a+'"]');if(b)b.focus()}

function openSettings(){var g=++A.gen;A.me=null;A.edit=false;A.busy=false;
  acct.innerHTML=head()+'<p class="mut" role="status">Загрузка…</p>';if(!acct.open)acct.showModal();
  api('POST','/api/auth',{action:'me'}).then(function(r){return r.json().catch(function(){return null}).then(function(j){
    if(g!==A.gen||!acct.open)return;
    if(r.status===401){authFail();return}
    if(!r.ok||!j||typeof j.id!=='string'){acct.innerHTML=head()+'<p class="err" role="alert">Не удалось загрузить данные аккаунта. Попробуйте позже.</p>';return}
    var t=j.tg&&j.tg.linked?{id:String(j.tg.id==null?'':j.tg.id),username:typeof j.tg.username==='string'?j.tg.username:''}:null;
    A.me={id:j.id,email:typeof j.email==='string'?j.email:'',tg:t};
    if(typeof j.name==='string')accSetName(j.name);
    render()})
  }).catch(function(){if(g===A.gen&&acct.open)acct.innerHTML=head()+'<p class="err" role="alert">Нет связи с сервером</p>'})}

function save(){var inp=$('acIn'),er=$('acErr');if(!inp||A.busy)return;
  var v=nrm(inp.value);
  if(v.length>NAME_MAX){er.textContent='Не больше '+NAME_MAX+' символов';return}
  if(/[\u0000-\u001f\u007f]/.test(v)){er.textContent='Уберите служебные символы';return}
  A.busy=true;er.textContent='';var g=A.gen;
  api('POST','/api/auth',{action:'rename',name:v}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){
    A.busy=false;if(g!==A.gen)return;
    if(r.status===401){authFail();return}
    if(!r.ok||typeof j.name!=='string'){var e2=$('acErr');if(e2)e2.textContent=j.error||'Не получилось сохранить. Попробуйте позже.';return}
    accSetName(j.name);A.edit=false;render();focusBtn('rename')})
  }).catch(function(){A.busy=false;var e3=$('acErr');if(g===A.gen&&e3)e3.textContent='Нет связи с сервером'})}

function unlink(){
  dlgConfirm('Отвязать Telegram? Напоминания перестанут приходить, пока не привяжете снова.').then(function(ok){
    if(!ok||!A.me)return;var g=A.gen;A.busy=true;
    api('DELETE','/api/tglink').then(function(r){A.busy=false;if(g!==A.gen)return;
      if(r.status===401){authFail();return}
      if(!r.ok){dlgAlert('Не получилось отвязать. Попробуйте позже.');return}
      A.me.tg=null;render();cb.tg()
    }).catch(function(){A.busy=false;if(g===A.gen)dlgAlert('Нет связи с сервером')})})}

function onAcct(e){var el=e.target.closest&&e.target.closest('[data-a]');if(!el)return;var a=el.getAttribute('data-a');
  if(a==='close'){acct.close();return}
  if(A.busy||!A.me)return;
  if(a==='rename'){A.edit=true;render()}
  else if(a==='cancel'){A.edit=false;render();focusBtn('rename')}
  else if(a==='save')save();
  else if(a==='unlink')unlink();
  else if(a==='del')openDel()}

/* ---------- удаление аккаунта: нужно ввести слово «удалить» ---------- */
function openDel(){
  del.innerHTML='<h2 id="delH">Удалить аккаунт навсегда?</h2>'+
    '<p>Будут безвозвратно удалены аккаунт и все его данные: кэшбэки, напоминания, WiFi, агент и привязка Telegram. Отменить это нельзя.</p>'+
    '<label for="delIn">Для подтверждения введите слово «'+WORD+'»</label>'+
    '<input id="delIn" autocomplete="off" autocapitalize="none" spellcheck="false">'+
    '<p class="err" id="delErr" role="alert"></p>'+
    '<div class="acts"><button class="btn" type="button" data-d="no">Отмена</button><button class="done danger" id="delGo" type="button" data-d="go" disabled>Удалить навсегда</button></div>';
  del.showModal();$('delIn').focus()}
function delOk(){var i=$('delIn');return !!i&&nrm(i.value).toLowerCase()===WORD}
function doDelete(){var er=$('delErr'),go=$('delGo');if(A.busy||!delOk())return;
  A.busy=true;go.disabled=true;er.textContent='';
  api('POST','/api/auth',{action:'delete',confirm:WORD}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){
    A.busy=false;
    if(r.status===401){del.close();authFail();return}
    if(!r.ok){er.textContent=j.error||'Не получилось удалить. Попробуйте позже.';go.disabled=!delOk();return}
    del.close();if(acct.open)acct.close();cb.gone()})
  }).catch(function(){A.busy=false;er.textContent='Нет связи с сервером';go.disabled=!delOk()})}

/* клик по затемнению (за пределами окна) закрывает окно */
function backdrop(d){d.addEventListener('click',function(e){if(e.target!==d)return;var r=d.getBoundingClientRect();
  if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()})}

/* h: {logout, tg, gone} — действия каркаса (main.js): выход, «привязка Telegram изменилась», «аккаунт удалён» */
export function initAccount(h){
  cb.logout=h.logout||cb.logout;cb.tg=h.tg||cb.tg;cb.gone=h.gone||cb.gone;
  uBtn=$('uBtn');uMenu=$('uMenu');acct=$('acctDlg');del=$('delDlg');
  uBtn.addEventListener('click',function(){if(uMenu.hidden)menuOpen(false);else menuClose(false)});
  uBtn.addEventListener('keydown',function(e){if(e.key==='ArrowDown'&&uMenu.hidden){e.preventDefault();menuOpen(true)}});
  uMenu.addEventListener('keydown',menuKey);
  uMenu.addEventListener('click',function(e){var el=e.target.closest&&e.target.closest('[data-u]');if(!el)return;
    var a=el.getAttribute('data-u');menuClose(false);
    if(a==='settings')openSettings();else if(a==='logout')cb.logout()});
  document.addEventListener('click',function(e){if(!uMenu.hidden&&!$('uWrap').contains(e.target))menuClose(false)});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!uMenu.hidden)menuClose(true)});
  acct.addEventListener('click',onAcct);backdrop(acct);
  acct.addEventListener('close',function(){A.edit=false;A.gen++;if(!$('uWrap').hidden)uBtn.focus()});
  del.addEventListener('click',function(e){var el=e.target.closest&&e.target.closest('[data-d]');if(!el)return;
    if(el.getAttribute('data-d')==='no')del.close();else doDelete()});
  del.addEventListener('input',function(){var go=$('delGo');if(go&&!A.busy)go.disabled=!delOk()});
  del.addEventListener('keydown',function(e){if(e.key==='Enter'&&e.target.id==='delIn'){e.preventDefault();doDelete()}});
  backdrop(del)}
