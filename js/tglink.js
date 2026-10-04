/* Привязка Telegram: блок «Telegram» на странице «Напоминания».
   Три состояния: не привязан -> ссылка выдана (ждём «Запустить» в Telegram) -> привязан. Сервер: api/tglink.js. */
import {$,esc} from './util.js';
import {api} from './api.js';
import {dlgConfirm} from './dialogs.js';

var T={st:null,url:'',until:0,timer:0,busy:false,gen:0};

function msg(t){var m=$('tgMsg');if(m)m.textContent=t||''}
function stop(){if(T.timer){clearInterval(T.timer);T.timer=0}}

function render(){var b=$('tgBody');if(!b)return;
  if(!T.st){b.innerHTML='';return}
  if(T.st.linked){
    b.innerHTML='<p class="tgn">Telegram привязан'+(T.st.username?': <b>@'+esc(T.st.username)+'</b>':'')+'. Бот будет присылать напоминания сюда.</p>'+
      '<div class="acts"><button class="btn" type="button" data-t="unlink">Отвязать</button></div>';return}
  if(T.url){
    b.innerHTML='<p class="tgn">Откройте ссылку и нажмите «Запустить» в Telegram. Ссылка одноразовая и действует 10 минут.</p>'+
      '<div class="acts"><a class="btn" href="'+esc(T.url)+'" target="_blank" rel="noopener noreferrer">Открыть Telegram</a>'+
      '<button class="lnk" type="button" data-t="link">Получить новую ссылку</button></div>';return}
  b.innerHTML='<p class="tgn">Привяжите Telegram, чтобы бот присылал вам напоминания.</p>'+
    '<button class="addbtn" type="button" data-t="link">Привязать Telegram</button>'}

/* Пока показана ссылка, раз в 4 секунды спрашиваем, нажали ли «Запустить» (только когда вкладка видна). */
function arm(){stop();var g=T.gen;
  T.timer=setInterval(function(){
    if(document.visibilityState!=='visible')return;
    if(Date.now()>T.until){stop();T.url='';render();msg('Ссылка устарела. Получите новую.');return}
    api('GET','/api/tglink').then(function(r){return r.ok?r.json():null}).then(function(j){
      if(g!==T.gen||!j||!j.linked)return;
      T.st=j;T.url='';stop();render();msg('Telegram привязан')}).catch(function(){})},4000)}

export function tgLoad(){var g=++T.gen;
  api('GET','/api/tglink').then(function(r){
    if(r.status===401)return;
    if(!r.ok)throw 0;
    return r.json().then(function(j){
      if(g!==T.gen)return;
      T.st=j;if(j.linked){T.url='';stop()}
      render();if(!j.linked&&T.url)arm()})
  }).catch(function(){if(g===T.gen)msg('Не удалось проверить привязку')})}

export function tgClear(){stop();T.gen++;T.st=null;T.url='';T.busy=false;render();msg('')}

function mk(){if(T.busy)return;T.busy=true;msg('');var g=T.gen;
  api('POST','/api/tglink',{}).then(function(r){return r.json().then(function(j){
    T.busy=false;if(g!==T.gen)return;
    if(!r.ok){if(r.status!==401)msg(j.error||'Не получилось. Попробуйте позже.');return}
    if(typeof j.url!=='string'||j.url.indexOf('https://t.me/')!==0){msg('Не получилось. Попробуйте позже.');return}
    T.st={linked:false};T.url=j.url;T.until=Date.now()+(j.ttl||600)*1000;render();arm()})
  }).catch(function(){T.busy=false;msg('Нет связи с сервером')})}

function unlink(){
  dlgConfirm('Отвязать Telegram? Напоминания перестанут приходить, пока не привяжете снова.').then(function(ok){
    if(!ok)return;var g=T.gen;msg('');
    api('DELETE','/api/tglink').then(function(r){
      if(g!==T.gen)return;
      if(!r.ok){if(r.status!==401)msg('Не получилось отвязать. Попробуйте позже.');return}
      T.st={linked:false};T.url='';render()
    }).catch(function(){msg('Нет связи с сервером')})})}

export function initTg(){var b=$('tgBody');if(!b)return;
  b.addEventListener('click',function(e){var el=e.target.closest&&e.target.closest('[data-t]');if(!el)return;
    if(el.getAttribute('data-t')==='link')mk();else if(el.getAttribute('data-t')==='unlink')unlink()})}
