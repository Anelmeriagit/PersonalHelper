/* WiFi: QR-код для подключения, показ и копирование пароля, печатная страница */
import {$,esc} from './util.js';
import {api,S,authFail} from './api.js';

var wifiBody=$('wifiBody'),wifiMsg=$('wifiMsg'),wf=null,wfShow=false,wfPrintPass=true,wfBusy=false,wfTimer=0;
export function wifiClear(){wf=null;wfShow=false;if(wifiBody)wifiBody.innerHTML='';if(wifiMsg)wifiMsg.textContent=''}
export function wifiNote(t){wifiMsg.textContent=t;clearTimeout(wfTimer);if(t)wfTimer=setTimeout(function(){wifiMsg.textContent=''},3000)}
export function qrSvg(q){var n=q.size+8,d='';
  q.rows.forEach(function(row,y){var x=0,s;while(x<row.length){if(row.charAt(x)==='1'){s=x;while(x<row.length&&row.charAt(x)==='1')x++;d+='M'+(s+4)+' '+(y+4)+'h'+(x-s)+'v1h-'+(x-s)+'z'}else x++}});
  return '<svg class="qr" viewBox="0 0 '+n+' '+n+'" role="img" aria-label="QR-код для подключения к WiFi" shape-rendering="crispEdges"><rect width="'+n+'" height="'+n+'" fill="#fff"/><path fill="#000" d="'+d+'"/></svg>'}
export function wfOpen(){return wf.security==='nopass'}
export function wfPwText(){return wfOpen()?'без пароля':(wfShow?esc(wf.password):'••••••••••')}
export function wfPrintHtml(){
  return '<h2 class="wpt">Подключение к WiFi</h2>'+qrSvg(wf.qr)+
    '<p class="wpn">Сеть: <b>'+esc(wf.ssid)+'</b></p>'+
    (!wfOpen()&&wfPrintPass?'<p class="wpn">Пароль: <b>'+esc(wf.password)+'</b></p>':'')+
    '<p class="wph">Откройте камеру телефона и наведите на код</p>'}
export function wifiRender(){
  if(!wf)return;
  if(!wf.configured){wifiBody.innerHTML='<div class="warn" role="status"><p>WiFi не настроен: задайте <b>WIFI_SSID</b> и <b>WIFI_PASSWORD</b> в настройках Vercel и сделайте redeploy.</p></div>';return}
  wifiBody.innerHTML='<div class="wscreen">'+
    '<div class="wqr">'+qrSvg(wf.qr)+'</div>'+
    '<dl class="wi"><div><dt>Сеть</dt><dd>'+esc(wf.ssid)+'</dd></div><div><dt>Пароль</dt><dd id="wPw">'+wfPwText()+'</dd></div></dl>'+
    '<div class="wact">'+(wfOpen()?'':'<button class="btn" type="button" id="wShow" data-wf="show" aria-pressed="'+wfShow+'">'+(wfShow?'Скрыть':'Показать')+'</button><button class="btn" type="button" data-wf="copy">Копировать пароль</button>')+
    '<button class="btn" type="button" data-wf="print">Печать</button></div>'+
    (wfOpen()?'':'<label class="wchk"><input type="checkbox" id="wPP"'+(wfPrintPass?' checked':'')+'> Показывать пароль на листе</label>')+
  '</div><div class="wprint" id="wPrint">'+wfPrintHtml()+'</div>'}
export function wifiLoad(){
  if(wfBusy)return;wfBusy=true;
  api('GET','/api/wifi').then(function(r){
    if(r.status===401){wfBusy=false;authFail();return}
    if(!r.ok)throw 0;
    return r.json().then(function(j){wfBusy=false;if(!S.loggedIn||S.page!=='wifi')return;wf=j;wifiRender()})
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
    else if(a==='print')window.print()});
  wifiBody.addEventListener('change',function(e){if(e.target.id==='wPP'&&wf){wfPrintPass=e.target.checked;$('wPrint').innerHTML=wfPrintHtml()}});
}
