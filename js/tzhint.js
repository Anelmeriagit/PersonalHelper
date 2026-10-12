/* Часовой пояс аккаунта на сайте: смена пояса (запрос set-tz) и подсказка, если пояс устройства отличается от пояса аккаунта (часть 4).
   Пояс сам не подставляется: подсказка предлагает сменить, «Оставить» запоминает пояс устройства в localStorage (`tzNo`) и больше о нём не напоминает;
   сменится пояс устройства — подсказка появится снова. Для гостя подсказки нет: его пояс — пояс устройства (main.js). Сервер: notes/reminders.md («Часовые пояса»). */
import {$,ls,lset} from './util.js';
import {api,S,authFail} from './api.js';
import {deviceTz,sameTz} from './tz.js';
import {tzShort,tzName} from './tzlist.js';

var box,cur=null,busy=false,onChanged=function(){};
/* смена пояса аккаунта: → {ok:true, tz, tzSet} | {ok:false, error} (401 переводит сайт в гостевой режим, error пустой) */
export function postTz(tz){
  return api('POST','/api/auth',{action:'set-tz',tz:tz}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){
    if(r.status===401){authFail();return{ok:false,error:''}}
    if(!r.ok||typeof j.tz!=='string')return{ok:false,error:typeof j.error==='string'&&j.error?j.error:'Не получилось сохранить. Попробуйте позже.'};
    return{ok:true,tz:j.tz,tzSet:j.tzSet===true}})
  }).catch(function(){return{ok:false,error:'Нет связи с сервером'}})}
function paint(dev){
  box.innerHTML='<p>Часовой пояс устройства — '+tzShort(dev)+', а в аккаунте — '+tzShort(cur)+'. Напоминания и агент считаются по поясу аккаунта.</p>'+
    '<div class="acts"><button class="btn" type="button" data-t="no">Оставить</button><button class="done" type="button" data-t="yes">Сменить на «'+tzName(dev)+'»</button></div>'+
    '<p class="err" id="tzHintErr" role="alert"></p>';
  box.hidden=false}
/* tz — действующий пояс аккаунта; вызывается при входе, после смены пояса и при возврате на вкладку */
export function tzHintCheck(tz){
  if(!box)return;
  cur=tz||cur;
  var dev=deviceTz();
  if(!S.acct||!cur||!dev||sameTz(dev,cur)||sameTz(ls('tzNo'),dev)){box.hidden=true;box.innerHTML='';return}
  if(!busy)paint(dev)}
export function initTzHint(changed){
  box=$('tzHint');onChanged=changed||onChanged;
  box.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-t]');if(!b||busy)return;
    var dev=deviceTz();if(!dev)return;
    if(b.getAttribute('data-t')==='no'){lset('tzNo',dev);box.hidden=true;box.innerHTML='';return}
    busy=true;b.disabled=true;
    postTz(dev).then(function(r){busy=false;
      if(r.ok){cur=r.tz;box.hidden=true;box.innerHTML='';onChanged(r.tz,r.tzSet);return}
      var er=$('tzHintErr');if(er)er.textContent=r.error;b.disabled=false})})}
