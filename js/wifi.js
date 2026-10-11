/* Wi-Fi: сети пользователя (до 5): карточки с QR-кодом для подключения, добавление, правка и удаление по id, показ и копирование пароля, печатная страница одной сети */
import {$,esc,IC} from './util.js';
import {api,S,authFail,stamp} from './api.js';
import {dlgConfirm} from './dialogs.js';

var NETS_MAX=5;
/* wf — ответ GET /api/wifi {configured, nets:[{id,ssid,password,security,hidden,qr}]}; wfShow[id] — пароль сети показан; wfPP[id] — галочка «Показывать пароль на листе» (по умолчанию включена);
   wfForm: false — список, 'new' — форма новой сети, иначе id правимой сети */
var wifiBody=$('wifiBody'),wifiMsg=$('wifiMsg'),wf=null,wfShow={},wfPP={},wfBusy=false,wfTimer=0,wfForm=false,wfSaving=false,wfPend=null,wfLast=null;
function wfNets(){return wf&&Array.isArray(wf.nets)?wf.nets:[]}
function wfFind(id){var a=wfNets(),i;for(i=0;i<a.length;i++)if(a[i].id===id)return a[i];return null}
/* при нескольких сетях рамка раздела шире: карточки встают в ряд */
function wfWide(on){var w=wifiBody&&wifiBody.parentNode;if(w)w.classList.toggle('wmulti',!!on)}
export function wifiClear(){wf=null;wfShow={};wfPP={};wfForm=false;wfSaving=false;wfWide(false);if(wifiBody)wifiBody.innerHTML='';if(wifiMsg)wifiMsg.textContent=''}
/* wfLast — последние полученные данные сетей: при уходе со вкладки wf очищается (пароли не висят в странице), а для гостевых данных при конце сессии нужна последняя копия; сбрасывается при переходе в гостя */
export function wifiForget(){wfLast=null;wfPend=null;wifiClear()}
/* список сетей из памяти страницы для гостевых данных, когда сессия закончилась: список с сетью, чья запись оборвалась на 401, иначе последний полученный;
   null — у аккаунта сетей нет, undefined — раздел за сессию не открывался (гостевые сети остаются как были) */
export function wifiSnapshot(){if(wfPend)return wfPend;var w=wf||wfLast;return w?(w.nets&&w.nets.length?w:null):undefined}
export function wifiNote(t){wifiMsg.textContent=t;clearTimeout(wfTimer);if(t)wfTimer=setTimeout(function(){wifiMsg.textContent=''},3000)}
export function qrSvg(q,name){var n=q.size+8,d='';
  q.rows.forEach(function(row,y){var x=0,s;while(x<row.length){if(row.charAt(x)==='1'){s=x;while(x<row.length&&row.charAt(x)==='1')x++;d+='M'+(s+4)+' '+(y+4)+'h'+(x-s)+'v1h-'+(x-s)+'z'}else x++}});
  return '<svg class="qr" viewBox="0 0 '+n+' '+n+'" role="img" aria-label="'+(name?'QR-код для подключения к сети '+esc(name):'QR-код для подключения к Wi-Fi')+'" shape-rendering="crispEdges"><rect width="'+n+'" height="'+n+'" fill="#fff"/><path fill="#000" d="'+d+'"/></svg>'}
function isOpen(n){return n.security==='nopass'}
function pwText(n){return isOpen(n)?'без пароля':(wfShow[n.id]?esc(n.password):'••••••••••')}
/* печатная страница одной сети; pass — печатать ли пароль (у открытой сети его нет вовсе) */
function printHtml(n,pass){
  return '<h2 class="wpt">Подключение к Wi-Fi</h2>'+qrSvg(n.qr,n.ssid)+
    '<p class="wpn">Сеть: <b>'+esc(n.ssid)+'</b></p>'+
    (!isOpen(n)&&pass?'<p class="wpn">Пароль: <b>'+esc(n.password)+'</b></p>':'')+
    '<p class="wph">Откройте камеру телефона и наведите на код</p>'}
/* значок глаза справа от пароля: показать или скрыть */
function eyeBtn(n){var s=!!wfShow[n.id],t=s?'Скрыть пароль':'Показать пароль';return '<button class="weye" type="button" data-wf="show" aria-pressed="'+s+'" aria-label="'+t+'" title="'+t+'">'+(s?IC.eyeoff:IC.eye)+'</button>'}
/* карточка одной сети: QR, строки «Сеть» и «Пароль», кнопки; id сети — в data-id карточки */
function card(n){var open=isOpen(n);
  return '<section class="wscreen wcard" data-id="'+esc(n.id)+'" aria-label="Сеть '+esc(n.ssid)+'">'+
    '<div class="wqr">'+qrSvg(n.qr,n.ssid)+'</div>'+
    '<dl class="wi"><div><dt>Сеть</dt><dd>'+esc(n.ssid)+'</dd></div><div><dt>Пароль</dt><dd class="wpd"><span class="wpw">'+pwText(n)+'</span>'+(open?'':eyeBtn(n))+'</dd></div></dl>'+
    '<div class="wact">'+(open?'':'<button class="btn" type="button" data-wf="copy">Копировать пароль</button>')+
    '<button class="btn" type="button" data-wf="print">Печать</button><button class="btn" type="button" data-wf="edit">Изменить сеть</button></div>'+
    (open?'':'<label class="wchk"><input type="checkbox" class="wpp"'+(wfPP[n.id]===false?'':' checked')+'> Показывать пароль на листе</label>')+
  '</section>'}
export function wifiRender(){
  if(!wf)return;
  var nets=wfNets();
  if(!nets.length)wfForm='new';
  else if(wfForm&&wfForm!=='new'&&!wfFind(wfForm))wfForm=false;
  if(wfForm){wfWide(false);wifiForm();return}
  wfWide(nets.length>1);
  wifiBody.innerHTML='<div class="wlist">'+nets.map(card).join('')+'</div>'+
    '<div class="wadd">'+(nets.length<NETS_MAX?'<button class="btn" type="button" data-wf="add">Добавить сеть</button>':'')+
    '<p class="wfn">'+(nets.length<NETS_MAX?'Сетей: '+nets.length+' из '+NETS_MAX:'Это предел: '+NETS_MAX+' сетей. Чтобы добавить новую, удалите одну из старых.')+'</p></div>'+
    '<div class="wprint" id="wPrint"></div>'}
/* форма данных сети: пустая для новой, с текущими значениями для правимой */
export function wifiForm(){var cur=wfForm==='new'?null:wfFind(wfForm),c=cur||{ssid:'',password:'',security:'WPA',hidden:false},sec=c.security,has=wfNets().length>0;
  wifiBody.innerHTML='<form class="fm wfm" id="wForm" novalidate>'+
    (cur?'':'<p class="wfn">'+(S.acct?'Введите данные своей сети. Они хранятся только в вашем аккаунте и показываются только после входа.':'Введите данные своей сети. Они хранятся только в этом браузере и никуда не отправляются.')+'</p>')+
    '<div class="wfl"><label for="wfSsid">Название сети</label><input id="wfSsid" maxlength="32" autocomplete="off" autocapitalize="none" spellcheck="false"></div>'+
    '<div class="wfl"><label for="wfSec">Защита</label><select id="wfSec"><option value="WPA"'+(sec==='WPA'?' selected':'')+'>WPA / WPA2 / WPA3</option><option value="WEP"'+(sec==='WEP'?' selected':'')+'>WEP</option><option value="nopass"'+(sec==='nopass'?' selected':'')+'>Без пароля</option></select></div>'+
    '<div class="wfl" id="wfPwBox"'+(sec==='nopass'?' hidden':'')+'><label for="wfPw">Пароль</label><input id="wfPw" type="password" maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false"><label class="chk"><input type="checkbox" id="wfPwShow"> Показать пароль</label></div>'+
    '<label class="chk"><input type="checkbox" id="wfHid"'+(c.hidden?' checked':'')+'> Скрытая сеть</label>'+
    '<p class="err" id="wfErr" role="alert"></p>'+
    '<div class="acts"><button class="done" type="submit">Сохранить</button>'+(has?'<button class="btn" type="button" data-wf="cancel">Отмена</button>':'')+(cur?'<button class="btn del" type="button" data-wf="del">Удалить сеть</button>':'')+'</div></form>';
  $('wfSsid').value=c.ssid;$('wfPw').value=c.password}
function wfError(code,sec){return code==='ssid'?'Название сети: от 1 до 32 байт (кириллица занимает по 2), без управляющих символов':
  code==='password'?(sec==='WEP'?'Пароль WEP: 5 или 13 символов либо 10 или 26 hex-цифр':'Пароль WPA: от 8 до 63 символов или 64 hex-цифры'):'Проверьте данные сети'}
/* список для гостевых данных, если запись оборвалась на 401: сети страницы плюс (или с заменой) сеть из формы */
function pendList(cfg,eid){var list=wfNets().map(function(n){return{id:n.id,ssid:n.ssid,password:n.password,security:n.security,hidden:n.hidden}});
  if(eid)list=list.map(function(n){return n.id===eid?Object.assign({id:eid},cfg):n});else list.push(cfg);
  return{nets:list}}
function wifiSave(){if(wfSaving)return;var err=$('wfErr'),sec=$('wfSec').value,btn=wifiBody.querySelector('.done'),eid=wfForm==='new'?'':wfForm;
  var cfg={ssid:$('wfSsid').value,security:sec,password:sec==='nopass'?'':$('wfPw').value,hidden:$('wfHid').checked},body=Object.assign({},cfg);
  if(eid)body.id=eid;else body.add=true;
  if(!cfg.ssid.trim()){err.textContent='Введите название сети';return}
  err.textContent='';wfSaving=true;btn.disabled=true;
  api('PUT','/api/wifi',body).then(function(r){return r.json().catch(function(){return{}}).then(function(j){
    wfSaving=false;
    if(r.status===401){wfPend=pendList(cfg,eid);authFail();return}
    if(r.status===404){wfForm=false;wifiNote('Эта сеть уже удалена');wifiLoad();return}
    if(r.status===400){err.textContent=j.error==='limit'?'Можно хранить не больше '+NETS_MAX+' сетей':wfError(j.error,sec);btn.disabled=false;return}
    if(!r.ok){err.textContent='Не удалось сохранить. Попробуйте ещё раз';btn.disabled=false;return}
    wf=wfLast=j;stamp('wifi');if(eid)delete wfShow[eid];wfForm=false;wifiRender();wifiNote('Сохранено')})
  }).catch(function(){wfSaving=false;err.textContent='Нет связи с сервером';btn.disabled=false})}
function wifiDelete(id){var n=wfFind(id);if(!n)return;
  dlgConfirm('Удалить сеть «'+n.ssid+'»? Показ и QR-код этой сети пропадут, пока вы не введёте её заново.').then(function(ok){if(!ok)return;
    api('DELETE','/api/wifi?id='+encodeURIComponent(id)).then(function(r){if(r.status===401){authFail();return}if(!r.ok){wifiNote('Не удалось удалить');return}
      return r.json().then(function(j){wf=wfLast=j;delete wfShow[id];delete wfPP[id];wfForm=false;wifiRender()},function(){wfForm=false;wifiLoad()})
    }).catch(function(){wifiNote('Нет связи с сервером')})})}
export function wifiLoad(){
  if(wfBusy)return;wfBusy=true;
  api('GET','/api/wifi').then(function(r){
    if(r.status===401){wfBusy=false;authFail();return}
    if(!r.ok)throw 0;
    return r.json().then(function(j){wfBusy=false;if(!S.loggedIn||S.page!=='wifi')return;stamp('wifi');wf=wfLast=j;if(wfForm&&$('wForm'))return;wfForm=false;wifiRender()})
  }).catch(function(){wfBusy=false;if(S.loggedIn&&S.page==='wifi'&&!wf)wifiBody.innerHTML='<p class="empty">Не удалось загрузить данные. Проверьте соединение и откройте вкладку снова.</p>'})}
function wifiCopy(n){var t=n&&n.password;if(!t)return;
  function fb(){var ta=document.createElement('textarea'),done=false;ta.value=t;ta.setAttribute('readonly','');ta.className='wcp';document.body.appendChild(ta);ta.select();
    try{done=document.execCommand('copy')}catch(e){}
    document.body.removeChild(ta);wifiNote(done?'Пароль скопирован':'Не удалось скопировать')}
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(function(){wifiNote('Пароль скопирован')},fb);else fb()}
/* печать одной сети: её страница собирается в #wPrint в момент нажатия (пароль других сетей и непечатаемых не лежит в странице) */
function wifiPrint(n,c){var cb=c.querySelector('.wpp'),box=$('wPrint');if(!box)return;box.innerHTML=printHtml(n,cb?cb.checked:true);window.print()}

export function initWifi(){
  wifiBody.addEventListener('click',function(e){var b=e.target.closest('button[data-wf]');if(!b||!wf)return;
    var a=b.getAttribute('data-wf'),c=b.closest('[data-id]'),id=c?c.getAttribute('data-id'):'',n=id?wfFind(id):null;
    if(a==='show'&&n){var s=wfShow[id]=!wfShow[id],t=s?'Скрыть пароль':'Показать пароль';c.querySelector('.wpw').textContent=pwText(n);b.innerHTML=s?IC.eyeoff:IC.eye;b.setAttribute('aria-pressed',String(s));b.setAttribute('aria-label',t);b.title=t}
    else if(a==='copy'&&n)wifiCopy(n);
    else if(a==='print'&&n)wifiPrint(n,c);
    else if(a==='edit'&&n){delete wfShow[id];wfForm=id;wifiRender()}
    else if(a==='add'){wfForm='new';wifiRender()}
    else if(a==='cancel'){wfForm=false;wifiRender()}
    else if(a==='del'&&wfForm&&wfForm!=='new')wifiDelete(wfForm)});
  wifiBody.addEventListener('submit',function(e){if(e.target.id!=='wForm')return;e.preventDefault();wifiSave()});
  wifiBody.addEventListener('change',function(e){var t=e.target,id=t.id,c;
    if(t.classList&&t.classList.contains('wpp')){c=t.closest('[data-id]');if(c)wfPP[c.getAttribute('data-id')]=t.checked}
    else if(id==='wfSec')$('wfPwBox').hidden=t.value==='nopass';
    else if(id==='wfPwShow')$('wfPw').type=t.checked?'text':'password'});
}
