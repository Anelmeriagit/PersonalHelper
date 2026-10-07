/* «Агент»: пары «приложение — время сброса», порядок меняется перетаскиванием. Загрузка и автосохранение страницы */
import {$,esc,opts,IC,nrm} from '../util.js';
import {api,S,authFail,fresh,stamp} from '../api.js';
import {dlgAlert,dlgPrompt} from '../dialogs.js';
import {A,AG_APPS,AG_MAX,AG_SAVE_MS,agId,agTwo,agNote,agRow,agCopy,agNextAt} from './state.js';
import {agNotifHtml,agMarks,agCheck,agFetchN,agMerge,agToggleNotify,initNotify} from './notify.js';
import {initDrag} from './drag.js';

var agBody=$('agBody'),agMsg=$('agMsg');
var AG_GRIP='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
export function agClear(){A.ag=null;A.n=null;A.nAt=0;clearTimeout(A.wake);A.wake=0;clearTimeout(A.timer);A.timer=0;if(agBody)agBody.innerHTML='';if(agMsg)agMsg.textContent=''}
var AG_BAD=/[<>"'`&\\\u0000-\u001f]/;
function agCustoms(){var seen={},out=[];A.ag.rows.forEach(function(r){var k=r.app.toLowerCase();if(AG_APPS.some(function(x){return x.id===r.app})||seen[k])return;seen[k]=1;out.push({id:r.app,t:r.app})});return out}
function agNewName(){return dlgPrompt('Название браузера или приложения (до 40 символов)','').then(function(x){var v=nrm(x);if(!v)return '';
  if(AG_BAD.test(v))return dlgAlert('В названии не должно быть символов < > " \' ` & \\').then(function(){return ''});
  var l=v.toLowerCase(),i,c=agCustoms();
  for(i=0;i<AG_APPS.length;i++)if(AG_APPS[i].id===l||AG_APPS[i].t.toLowerCase()===l)return AG_APPS[i].id;
  for(i=0;i<c.length;i++)if(c[i].id.toLowerCase()===l)return c[i].id;
  return v})}
function agNum(v){return v===null||v===undefined?'':String(v)}
function agRowHtml(r){var hs=[],ms=[],i;
  for(i=0;i<24;i++)hs.push({id:String(i),t:agTwo(i)});
  for(i=0;i<60;i+=10)ms.push({id:String(i),t:agTwo(i)});
  return '<div class="agr" data-id="'+esc(r.id)+'">'+
    '<button class="agh" type="button" data-ag="grip" aria-label="Переместить строку (стрелки вверх и вниз)">'+AG_GRIP+'</button>'+
    '<select class="aga" data-k="app" aria-label="Приложение">'+opts(AG_APPS.concat(A.cu),r.app,'Приложение')+'<option value="__new">＋ Свой вариант…</option></select>'+
    '<select class="agt'+(r.h===null?' ph':'')+'" data-k="h" aria-label="Часы">'+opts(hs,agNum(r.h),'ч')+'</select><span class="agc" aria-hidden="true">:</span>'+
    '<select class="agt'+(r.m===null?' ph':'')+'" data-k="m" aria-label="Минуты">'+opts(ms,agNum(r.m),'мин')+'</select>'+
    '<button class="x" type="button" data-ag="del" aria-label="Удалить строку">'+IC.x+'</button>'+
    '<div class="agm" hidden><span class="ags"></span><button class="chip agz" type="button" data-ag="reset" aria-label="Сбросить время" hidden>Сбросить</button></div></div>'}
function agRender(){if(!A.ag){agBody.innerHTML='';return}
  A.cu=agCustoms();
  agBody.innerHTML=agNotifHtml()+(A.ag.rows.length?'<div class="agl">'+A.ag.rows.map(agRowHtml).join('')+'</div>':'<p class="empty">Строк нет. Добавьте первую.</p>')+
    '<button class="addbtn" type="button" data-ag="add"'+(A.ag.rows.length>=AG_MAX?' disabled':'')+'>+ Добавить строку</button>';agMarks()}
export function agLoad(){if(A.busy)return;A.busy=true;
  api('GET','/api/agent').then(function(r){A.busy=false;if(r.status===401){authFail();return}if(!r.ok)throw 0;
    return r.json().then(function(j){if(!S.loggedIn)return;A.n=agCopy(j.rows);A.nAt=Date.now();stamp('ag');
      if(S.page!=='agent'||A.timer||A.saving||A.drag){agCheck();return}
      A.ag={rows:agCopy(j.rows)};var mig=false;
      A.ag.rows.forEach(function(r){if(r.h!==null&&r.m!==null&&!r.at){r.at=agNextAt(r.h,r.m);mig=true}});
      agRender();if(mig)agSchedule();agCheck()})
  }).catch(function(){A.busy=false;if(S.loggedIn&&S.page==='agent'&&!A.ag)agBody.innerHTML='<p class="empty">Не удалось загрузить данные. Проверьте соединение и откройте страницу снова.</p>'})}
function agSchedule(){agNote('…',true);clearTimeout(A.timer);A.timer=setTimeout(function(){agFlush(false)},AG_SAVE_MS)}
function agFlush(ka){clearTimeout(A.timer);A.timer=0;if(!A.ag)return;if(A.saving){A.again=true;return}A.saving=true;
  api('PUT','/api/agent',{rows:A.ag.rows},ka).then(function(r){A.saving=false;if(r.status===401){authFail();return}if(!r.ok)throw 0;
    return r.json().catch(function(){return null}).then(function(j){agMerge(j);
      if(A.again){A.again=false;agFlush(document.visibilityState==='hidden')}else agNote('Сохранено ✓')})
  }).catch(function(){A.saving=false;A.again=false;agNote('Не удалось сохранить. Проверьте соединение и измените строку ещё раз.',true)})}
/* уход со вкладки: ждущая отправка уходит сразу (keepalive); если сейчас идёт сохранение, а за ним правка (A.again), её отправит цепочка в agFlush */
export function agLeave(){if((A.timer||A.again)&&S.loggedIn)agFlush(true)}

/* вкладка снова видна: не чаще раза в REFRESH_MS (api.js). На странице «Агент» перечитать строки (если ничего не сохраняется и не тянут), на других страницах
   обновить строки для уведомлений (agFetchN, если уведомления включены); проверить сброс */
export function agVisible(){
  if(!S.loggedIn)return;
  if(S.page==='agent'){if(!A.timer&&!A.saving&&!A.drag&&!fresh('ag'))agLoad()}
  else agFetchN();
  agCheck()}
/* страница переключилась: на «Агенте» загрузить строки всегда (они же обновляют данные для уведомлений), на других страницах обновить данные уведомлений не чаще раза в REFRESH_MS */
export function agOnPage(){
  if(!S.loggedIn)return;
  if(S.page==='agent'){if(!A.drag)agLoad()}
  else agFetchN()}

export function initAgent(){
  A.render=agRender;
  agBody.addEventListener('change',function(e){var s=e.target.closest('select[data-k]');if(!s||!A.ag)return;
    var row=s.closest('.agr'),r=row&&agRow(row.getAttribute('data-id')),k=s.getAttribute('data-k');if(!r)return;
    if(k==='app'&&s.value==='__new'){agNewName().then(function(n){if(n&&A.ag){r.app=n;agRender();agSchedule()}else agRender()});return}
    r[k]=k==='app'?s.value:parseInt(s.value,10);if(k!=='app')r.at=r.h!==null&&r.m!==null?agNextAt(r.h,r.m):null;s.classList.remove('ph');agSchedule();agMarks();agCheck()});
agBody.addEventListener('click',function(e){var b=e.target.closest('button[data-ag]');if(!b||!A.ag)return;var a=b.getAttribute('data-ag');
    if(a==='add'){if(A.ag.rows.length>=AG_MAX)return;
      var used=A.ag.rows.map(function(r){return r.app}),free=AG_APPS.filter(function(x){return used.indexOf(x.id)<0})[0];
      A.ag.rows.push({id:agId(),app:(free||AG_APPS[0]).id,h:null,m:null});agRender();agSchedule()}
    else if(a==='del'){var row=b.closest('.agr'),id=row&&row.getAttribute('data-id');
      A.ag.rows=A.ag.rows.filter(function(r){return r.id!==id});agRender();agSchedule()}
    else if(a==='reset'){var rw=b.closest('.agr'),rid=rw&&rw.getAttribute('data-id'),rr=rid&&agRow(rid),hs;
      if(!rr)return;rr.h=null;rr.m=null;rr.at=null;agRender();agSchedule();agCheck();agNote('Время сброшено, укажите новое');
      hs=agBody.querySelector('.agr[data-id="'+rid+'"] select[data-k="h"]');if(hs)hs.focus()}
    else if(a==='notify')agToggleNotify()});
  initDrag(agSchedule);
  initNotify();
}
