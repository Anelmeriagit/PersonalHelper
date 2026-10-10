/* Wi-Fi: личная сеть пользователя (ввод и правка), QR-код для подключения, показ и копирование пароля, печатная страница */
import {$,esc} from './util.js';
import {api,S,authFail,stamp} from './api.js';
import {dlgConfirm} from './dialogs.js';

var wifiBody=$('wifiBody'),wifiMsg=$('wifiMsg'),wf=null,wfShow=false,wfPrintPass=true,wfBusy=false,wfTimer=0,wfForm=false,wfSaving=false,wfPend=null,wfLast=null;
export function wifiClear(){wf=null;wfShow=false;wfForm=false;wfSaving=false;if(wifiBody)wifiBody.innerHTML='';if(wifiMsg)wifiMsg.textContent=''}
/* wfLast — последние полученные данные сети: при уходе со вкладки wf очищается (пароль не висит в странице), а для гостевых данных при конце сессии нужна последняя копия; сбрасывается при переходе в гостя */
export function wifiForget(){wfLast=null;wfPend=null;wifiClear()}
/* сеть из памяти страницы для гостевых данных, когда сессия закончилась: сеть, чья запись оборвалась на 401, иначе последняя полученная;
   null — у аккаунта сети нет, undefined — раздел за сессию не открывался (гостевая сеть остаётся как была) */
export function wifiSnapshot(){if(wfPend)return wfPend;var w=wf||wfLast;return w?(w.configured?w:null):undefined}
export function wifiNote(t){wifiMsg.textContent=t;clearTimeout(wfTimer);if(t)wfTimer=setTimeout(function(){wifiMsg.textContent=''},3000)}
export function qrSvg(q){var n=q.size+8,d='';
  q.rows.forEach(function(row,y){var x=0,s;while(x<row.length){if(row.charAt(x)==='1'){s=x;while(x<row.length&&row.charAt(x)==='1')x++;d+='M'+(s+4)+' '+(y+4)+'h'+(x-s)+'v1h-'+(x-s)+'z'}else x++}});
  return '<svg class="qr" viewBox="0 0 '+n+' '+n+'" role="img" aria-label="QR-код для подключения к Wi-Fi" shape-rendering="crispEdges"><rect width="'+n+'" height="'+n+'" fill="#fff"/><path fill="#000" d="'+d+'"/></svg>'}
export function wfOpen(){return wf.security==='nopass'}
export function wfPwText(){return wfOpen()?'без пароля':(wfShow?esc(wf.password):'••••••••••')}
export function wfPrintHtml(){
  return '<h2 class="wpt">Подключение к Wi-Fi</h2>'+qrSvg(wf.qr)+
    '<p class="wpn">Сеть: <b>'+esc(wf.ssid)+'</b></p>'+
    (!wfOpen()&&wfPrintPass?'<p class="wpn">Пароль: <b>'+esc(wf.password)+'</b></p>':'')+
    '<p class="wph">Откройте камеру телефона и наведите на код</p>'}
export function wifiRender(){
  if(!wf)return;
  if(!wf.configured)wfForm=true;
  if(wfForm){wifiForm();return}
  wifiBody.innerHTML='<div class="wscreen">'+
    '<div class="wqr">'+qrSvg(wf.qr)+'</div>'+
    '<dl class="wi"><div><dt>Сеть</dt><dd>'+esc(wf.ssid)+'</dd></div><div><dt>Пароль</dt><dd id="wPw">'+wfPwText()+'</dd></div></dl>'+
    '<div class="wact">'+(wfOpen()?'':'<button class="btn" type="button" id="wShow" data-wf="show" aria-pressed="'+wfShow+'">'+(wfShow?'Скрыть':'Показать')+'</button><button class="btn" type="button" data-wf="copy">Копировать пароль</button>')+
    '<button class="btn" type="button" data-wf="print">Печать</button><button class="btn" type="button" data-wf="edit">Изменить сеть</button></div>'+
    (wfOpen()?'':'<label class="wchk"><input type="checkbox" id="wPP"'+(wfPrintPass?' checked':'')+'> Показывать пароль на листе</label>')+
  '</div><div class="wprint" id="wPrint">'+wfPrintHtml()+'</div>'}
/* форма данных сети: пустая, если сеть не задана, иначе с текущими значениями */
export function wifiForm(){var c=wf&&wf.configured?wf:{ssid:'',password:'',security:'WPA',hidden:false},sec=c.security;
  wifiBody.innerHTML='<form class="fm wfm" id="wForm" novalidate>'+
    (wf&&wf.configured?'':'<p class="wfn">'+(S.acct?'Введите данные своей сети. Они хранятся только в вашем аккаунте и показываются только после входа.':'Введите данные своей сети. Они хранятся только в этом браузере и никуда не отправляются.')+'</p>')+
    '<div class="wfl"><label for="wfSsid">Название сети</label><input id="wfSsid" maxlength="32" autocomplete="off" autocapitalize="none" spellcheck="false"></div>'+
    '<div class="wfl"><label for="wfSec">Защита</label><select id="wfSec"><option value="WPA"'+(sec==='WPA'?' selected':'')+'>WPA / WPA2 / WPA3</option><option value="WEP"'+(sec==='WEP'?' selected':'')+'>WEP</option><option value="nopass"'+(sec==='nopass'?' selected':'')+'>Без пароля</option></select></div>'+
    '<div class="wfl" id="wfPwBox"'+(sec==='nopass'?' hidden':'')+'><label for="wfPw">Пароль</label><input id="wfPw" type="password" maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false"><label class="chk"><input type="checkbox" id="wfPwShow"> Показать пароль</label></div>'+
    '<label class="chk"><input type="checkbox" id="wfHid"'+(c.hidden?' checked':'')+'> Скрытая сеть</label>'+
    '<p class="err" id="wfErr" role="alert"></p>'+
    '<div class="acts"><button class="done" type="submit">Сохранить</button>'+(wf&&wf.configured?'<button class="btn" type="button" data-wf="cancel">Отмена</button><button class="btn del" type="button" data-wf="del">Удалить сеть</button>':'')+'</div></form>';
  $('wfSsid').value=c.ssid;$('wfPw').value=c.password}
function wfError(code,sec){return code==='ssid'?'Название сети: от 1 до 32 байт (кириллица занимает по 2), без управляющих символов':
  code==='password'?(sec==='WEP'?'Пароль WEP: 5 или 13 символов либо 10 или 26 hex-цифр':'Пароль WPA: от 8 до 63 символов или 64 hex-цифры'):'Проверьте данные сети'}
function wifiSave(){if(wfSaving)return;var err=$('wfErr'),sec=$('wfSec').value,btn=wifiBody.querySelector('.done');
  var body={ssid:$('wfSsid').value,security:sec,password:sec==='nopass'?'':$('wfPw').value,hidden:$('wfHid').checked};
  if(!body.ssid.trim()){err.textContent='Введите название сети';return}
  err.textContent='';wfSaving=true;btn.disabled=true;
  api('PUT','/api/wifi',body).then(function(r){return r.json().catch(function(){return{}}).then(function(j){
    wfSaving=false;
    if(r.status===401){wfPend=body;authFail();return}
    if(r.status===400){err.textContent=wfError(j.error,sec);btn.disabled=false;return}
    if(!r.ok){err.textContent='Не удалось сохранить. Попробуйте ещё раз';btn.disabled=false;return}
    wf=wfLast=j;stamp('wifi');wfForm=false;wfShow=false;wifiRender();wifiNote('Сохранено')})
  }).catch(function(){wfSaving=false;err.textContent='Нет связи с сервером';btn.disabled=false})}
function wifiDelete(){dlgConfirm('Удалить данные сети? Показ и QR-код пропадут, пока вы не введёте сеть заново.').then(function(ok){if(!ok)return;
  api('DELETE','/api/wifi').then(function(r){if(r.status===401){authFail();return}if(!r.ok){wifiNote('Не удалось удалить');return}
    wf=wfLast={configured:false};wfForm=true;wfShow=false;wifiRender()}).catch(function(){wifiNote('Нет связи с сервером')})})}
export function wifiLoad(){
  if(wfBusy)return;wfBusy=true;
  api('GET','/api/wifi').then(function(r){
    if(r.status===401){wfBusy=false;authFail();return}
    if(!r.ok)throw 0;
    return r.json().then(function(j){wfBusy=false;if(!S.loggedIn||S.page!=='wifi')return;stamp('wifi');wf=wfLast=j;if(wfForm&&$('wForm'))return;wfForm=false;wifiRender()})
  }).catch(function(){wfBusy=false;if(S.loggedIn&&S.page==='wifi'&&!wf)wifiBody.innerHTML='<p class="empty">Не удалось загрузить данные. Проверьте соединение и откройте вкладку снова.</p>'})}
export function wifiCopy(){var t=wf&&wf.password;if(!t)return;
  function fb(){var ta=document.createElement('textarea'),done=false;ta.value=t;ta.setAttribute('readonly','');ta.className='wcp';document.body.appendChild(ta);ta.select();
    try{done=document.execCommand('copy')}catch(e){}
    document.body.removeChild(ta);wifiNote(done?'Пароль скопирован':'Не удалось скопировать')}
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(function(){wifiNote('Пароль скопирован')},fb);else fb()}

export function initWifi(){
  wifiBody.addEventListener('click',function(e){var b=e.target.closest('button[data-wf]');if(!b||!wf)return;var a=b.getAttribute('data-wf');
    if(a==='show'){wfShow=!wfShow;$('wPw').textContent=wfPwText();b.textContent=wfShow?'Скрыть':'Показать';b.setAttribute('aria-pressed',String(wfShow))}
    else if(a==='copy')wifiCopy();
    else if(a==='print')window.print();
    else if(a==='edit'){wfForm=true;wfShow=false;wifiRender()}
    else if(a==='cancel'){wfForm=false;wifiRender()}
    else if(a==='del')wifiDelete()});
  wifiBody.addEventListener('submit',function(e){if(e.target.id!=='wForm')return;e.preventDefault();wifiSave()});
  wifiBody.addEventListener('change',function(e){var id=e.target.id;
    if(id==='wPP'&&wf){wfPrintPass=e.target.checked;$('wPrint').innerHTML=wfPrintHtml()}
    else if(id==='wfSec')$('wfPwBox').hidden=e.target.value==='nopass';
    else if(id==='wfPwShow')$('wfPw').type=e.target.checked?'text':'password'});
}
