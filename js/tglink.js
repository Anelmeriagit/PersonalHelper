/* Привязка Telegram: блок «Telegram» на странице «Напоминания».
   Три состояния: не привязан -> ссылка выдана (ждём «Запустить» в Telegram) -> привязан. Сервер: api/tglink.js.
   Состояние «привязан / не привязан» и @имя приходят в ответе GET /api/reminders (tgApply вызывает reminders/index.js), поэтому при входе на страницу
   отдельного запроса нет. GET /api/tglink нужен только опросу привязки, пока показана ссылка. */
import {$,esc} from './util.js';
import {api,authFail} from './api.js';

var T={st:null,url:'',until:0,timer:0,busy:false,gen:0,polling:false,n:0},changed=function(){};

function msg(t){var m=$('tgMsg');if(m)m.textContent=t||''}
function stop(){if(T.timer){clearTimeout(T.timer);T.timer=0}}

function render(){var b=$('tgBody'),x=$('tgBox');if(!b)return;
  if(x)x.classList.toggle('ok',!!(T.st&&T.st.linked));
  if(!T.st){b.innerHTML='';return}
  if(T.st.linked){b.innerHTML='<p class="tgn">Telegram привязан. Бот будет отправлять напоминания.</p>';return}
  if(T.url){
    b.innerHTML='<p class="tgn">Откройте ссылку и нажмите «Запустить» в Telegram. Ссылка одноразовая и действует 10 минут.</p>'+
      '<div class="acts"><a class="btn" href="'+esc(T.url)+'" target="_blank" rel="noopener noreferrer">Открыть Telegram</a>'+
      '<button class="lnk" type="button" data-t="link">Получить новую ссылку</button></div>';return}
  b.innerHTML='<p class="tgn">Привяжите Telegram, чтобы бот присылал вам напоминания.</p>'+
    '<button class="addbtn" type="button" data-t="link">Привязать Telegram</button>'}

/* Опрос привязки: пока показана ссылка, спрашиваем сервер, нажали ли «Запустить». Паузы растут: 4 с (первые 5 раз), 8 с (следующие 5), дальше 15 с.
   Вкладка скрыта: запросов нет. При возврате на вкладку одна проверка сразу (tgVisible). Через 10 минут (срок ссылки) опрос прекращается. */
var POLL_STEPS=[4000,8000,15000],POLL_EACH=5;
function pause(n){return POLL_STEPS[Math.min(POLL_STEPS.length-1,Math.floor(n/POLL_EACH))]}
function expire(){stop();T.url='';render();msg('Ссылка устарела. Получите новую.')}
function poll(g){if(T.polling)return;T.polling=true;
  api('GET','/api/tglink').then(function(r){T.polling=false;if(r.status===401){authFail();return null}return r.ok?r.json():null}).then(function(j){
    if(g!==T.gen||!j||!j.linked)return;
    T.st=j;T.url='';stop();render();msg('');changed()}).catch(function(){T.polling=false})}
function arm(){stop();T.n=0;var g=T.gen;
  (function next(){T.timer=setTimeout(function(){T.timer=0;
    if(g!==T.gen||!T.url)return;
    if(Date.now()>T.until){expire();return}
    if(document.visibilityState==='visible')poll(g);
    next()},pause(T.n++))})()}

/* Вкладка браузера снова видна: если ждём «Запустить», проверить привязку сразу (человек как раз вернулся из Telegram) */
export function tgVisible(){if(!T.url||!T.timer)return;
  if(Date.now()>T.until){expire();return}
  poll(T.gen)}

/* Состояние привязки из ответа GET /api/reminders ({linked, username?}). Показанную ссылку не трогает, пока не привязали; без изменений не перерисовывает. */
export function tgApply(j){if(!j||typeof j.linked!=='boolean')return;
  var was=T.st;
  if(j.linked){var un=typeof j.username==='string'?j.username:'',pend=!!T.url;
    if(was&&was.linked&&was.username===un&&!pend)return;
    T.st={linked:true,username:un};T.url='';stop();render();if(pend)msg('');return}
  if(T.url||(was&&!was.linked))return;
  T.st={linked:false};render()}

export function tgClear(){stop();T.gen++;T.st=null;T.url='';T.busy=false;render();msg('')}

function mk(){if(T.busy)return;T.busy=true;msg('');var g=T.gen;
  api('POST','/api/tglink',{}).then(function(r){return r.json().then(function(j){
    T.busy=false;if(g!==T.gen)return;
    if(r.status===401){authFail();return}
    if(!r.ok){msg(j.error||'Не получилось. Попробуйте позже.');return}
    if(typeof j.url!=='string'||j.url.indexOf('https://t.me/')!==0){msg('Не получилось. Попробуйте позже.');return}
    T.st={linked:false};T.url=j.url;T.until=Date.now()+(j.ttl||600)*1000;render();arm()})
  }).catch(function(){T.busy=false;msg('Нет связи с сервером')})}

/* onChange — вызывается, когда привязка изменилась (привязали; отвязка только в настройках аккаунта): страница обновляет предупреждение «не привязан». */
export function initTg(onChange){changed=onChange||changed;var b=$('tgBody');if(!b)return;
  b.addEventListener('click',function(e){var el=e.target.closest&&e.target.closest('[data-t]');if(!el)return;
    if(el.getAttribute('data-t')==='link')mk()})}
