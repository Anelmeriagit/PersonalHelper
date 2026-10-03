/* «Агент»: ближайший сброс, подсветка строк и уведомление в момент сброса.
   У строки есть `at` — момент сброса в мс (считает сервер, см. api/agent.js). Уведомление показывает сам сайт,
   пока он открыт (вкладка или установленное приложение): на тарифе Hobby сервер по таймеру ничего не отправит. */
import {$} from '../util.js';
import {api,S,authFail} from '../api.js';
import {A,AG_GRACE,agTwo,agRow,agCopy,agDay,agUntil,agName} from './state.js';

var agBody=$('agBody');
function agSrc(){return S.page==='agent'&&A.ag?A.ag.rows:(A.n||[])}
export function agMerge(j){if(!j||!j.rows)return;A.n=agCopy(j.rows);
  if(A.ag&&!A.timer&&!A.again){j.rows.forEach(function(x){var l=agRow(x.id);if(l)l.at=x.at||null});agMarks()}
  agCheck()}
/* подсветка: ближайший будущий сброс и подписи в строках */
export function agMarks(){if(!A.ag||!agBody)return;
  var now=Date.now(),best=null,els=agBody.querySelectorAll('.agr'),i,r,e,t,has;
  A.ag.rows.forEach(function(x){if(x.at&&x.at>now&&(!best||x.at<best.at))best=x});
  for(i=0;i<els.length;i++){e=els[i];r=agRow(e.getAttribute('data-id'));if(!r)continue;
    has=r.h!==null||r.m!==null;t='';
    if(r.h!==null&&r.m===null)t='Укажите минуты';else if(r.h===null&&r.m!==null)t='Укажите часы';
    else if(r.at){if(r.at>now){t=(agDay(r.at)!==agDay(now)?'завтра · ':'')+'через '+agUntil(r.at-now);if(r===best)t='Ближайший · '+t}else t='Сброс прошёл'}
    e.classList.toggle('next',r===best);e.classList.toggle('past',!!r.at&&r.at<=now);
    e.querySelector('.agm').hidden=!has;e.querySelector('.agz').hidden=!has;e.querySelector('.ags').textContent=t}}
/* уведомления */
function agCan(){return typeof Notification!=='undefined'}
function agPref(){try{return localStorage.getItem('agNotify')==='1'}catch(e){return false}}
function agActive(){return agCan()&&agPref()&&Notification.permission==='granted'}
export function agNotifHtml(){var on=agActive(),b='',t;
  if(!agCan())t='Этот браузер не поддерживает уведомления. На iPhone они работают только в приложении, добавленном на экран «Домой».';
  else if(Notification.permission==='denied')t='Уведомления запрещены в настройках браузера для этого сайта.';
  else{b='<button class="chip'+(on?' on':'')+'" type="button" data-ag="notify" aria-pressed="'+on+'">'+(on?'Уведомления включены':'Включить уведомления')+'</button>';
    t='Придёт в момент сброса, пока сайт открыт (вкладка или установленное приложение).'}
  return'<div class="agn">'+b+'<p class="rd">'+t+'</p></div>'}
function agSwReg(){if(A.sw||!navigator.serviceWorker)return;A.sw=true;navigator.serviceWorker.register('/sw.js').catch(function(){A.sw=false})}
function agShow(title,body,tag){var o={body:body,tag:tag,lang:'ru',icon:'/Icons/apple-touch-icon.png'};
  function plain(){try{var n=new Notification(title,o);n.onclick=function(){window.focus();location.hash='#agent'}}catch(e){}}
  if(A.sw&&navigator.serviceWorker)navigator.serviceWorker.ready.then(function(reg){return reg.showNotification(title,o)}).catch(plain);else plain()}
export function agToggleNotify(){
  if(agActive()){try{localStorage.setItem('agNotify','0')}catch(e){}A.render();return}
  if(!agCan())return;
  var fin=false;function done(p){if(fin)return;fin=true;
    if(p==='granted'){try{localStorage.setItem('agNotify','1')}catch(e){}agSwReg();agCheck();agShow('Уведомления включены','Сообщение придёт в момент сброса.','ag-test');agFetchN(true)}
    A.render()}
  try{var pr=Notification.requestPermission(done);if(pr&&pr.then)pr.then(done)}catch(e){A.render()}}
/* отметки «уже показано» хранятся на устройстве: после перезагрузки страницы то же уведомление не повторится */
function agFired(){if(!A.fm){try{A.fm=JSON.parse(localStorage.getItem('agFired')||'{}')}catch(e){A.fm=null}if(!A.fm||typeof A.fm!=='object')A.fm={}}return A.fm}
function agFiredSave(){try{localStorage.setItem('agFired',JSON.stringify(A.fm))}catch(e){}}
/* строки для уведомлений вне страницы «Агент»: берём при открытии и при возврате на вкладку, не чаще раза в минуту */
export function agFetchN(force){if(!S.loggedIn||A.nBusy||!agActive())return;agSwReg();
  if(!force&&A.n&&Date.now()-A.nAt<60000){agCheck();return}
  A.nBusy=true;
  api('GET','/api/agent').then(function(r){A.nBusy=false;if(r.status===401){authFail();return}if(!r.ok)throw 0;
    return r.json().then(function(j){if(!S.loggedIn)return;A.nAt=Date.now();if(!(A.ag&&S.page==='agent'))A.n=agCopy(j.rows);agCheck()})
  }).catch(function(){A.nBusy=false})}
/* проверка: наступившее время — показать (если не старше получаса) и запомнить; следующий запуск — точно ко времени ближайшего сброса */
export function agCheck(){var rows=agSrc(),now=Date.now(),f,wake=0,ch=false,seen={},i,r;
  clearTimeout(A.wake);A.wake=0;if(!S.loggedIn||!rows.length)return;
  f=agFired();
  for(i=0;i<rows.length;i++){r=rows[i];if(!r.at)continue;seen[r.id]=1;
    if(r.at>now){if(!wake||r.at<wake)wake=r.at;continue}
    if(f[r.id]===r.at)continue;
    f[r.id]=r.at;ch=true;
    if(now-r.at<=AG_GRACE&&agActive())agShow('Сброс: '+agName(r.app),'Время сброса — '+agTwo(r.h)+':'+agTwo(r.m)+' по Москве.','ag-'+r.id+'-'+r.at)}
  Object.keys(f).forEach(function(k){if(!seen[k]){delete f[k];ch=true}});
  if(ch)agFiredSave();
  if(wake)A.wake=setTimeout(agCheck,Math.min(wake-now+300,2147000000));
  if(S.page==='agent')agMarks()}

export function initNotify(){
  setInterval(function(){if(S.loggedIn)agCheck()},30000);
}
