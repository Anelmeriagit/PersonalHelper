/* Слияние гостевых данных с аккаунтом при входе через Google (гостевой режим, часть 4).
   Один раз на аккаунт в этом браузере (метка g-mg, js/local.js); правила слияния — mergeCb, mergeAg в local.js.
   Запросы идут напрямую на сервер (net), мимо api(): сессия уже есть, а 401 здесь не должен переводить сайт в гостя.
   Не удалось записать (нет связи, 5xx, 409, 429, 401) — метка не ставится, слияние повторится при следующем открытии сайта; повтор безопасен (результат тот же). */
import {net} from './api.js';
import {guestDump,guestMerged,guestMark,mergeCb,mergeAg} from './local.js';

/* ответ раздела с аккаунта или null */
function jget(u){return net('GET',u).then(function(r){return r.ok?r.json():null}).catch(function(){return null})}
/* запись: {status, body} или null, если связи нет */
function put(u,b){return net('PUT',u,b).then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{status:r.status,body:j}})}).catch(function(){return null})}
/* ответ окончательный (записано или сервер отказал): повторять незачем */
function final(x){return !!x&&x.status<500&&x.status!==401&&x.status!==409&&x.status!==429}
var DONE={done:true,n:0},RETRY={done:false,n:0};

function doCb(j,g){
  if(!g)return Promise.resolve(DONE);
  var m=mergeCb(j.data,g),parts={};
  if(!m.parts.length)return Promise.resolve(DONE);
  m.parts.forEach(function(k){parts[k]={base:(j.rev&&j.rev[k])||0,value:k==='custom'?m.data.custom:(m.data.months[k]||[])}});
  return put('/api/data',{parts:parts}).then(function(x){
    if(!final(x))return RETRY;
    if(x.status!==200)return DONE;
    return{done:true,n:m.parts.length,j:{id:j.id,name:j.name,data:m.data,rev:Object.assign({},j.rev,x.body.rev)}}})}
function doAg(g){
  if(!g)return Promise.resolve(DONE);
  return jget('/api/agent').then(function(a){
    if(!a||!Array.isArray(a.rows))return RETRY;
    var m=mergeAg(a.rows,g);
    if(!m.changed)return DONE;
    return put('/api/agent',{rows:m.rows}).then(function(x){return final(x)?{done:true,n:x.status===200?1:0}:RETRY})})}
function doWf(g){
  if(!g)return Promise.resolve(DONE);
  return jget('/api/wifi').then(function(a){
    if(!a)return RETRY;
    if(a.configured)return DONE;
    return put('/api/wifi',{ssid:g.ssid,security:g.security,password:g.password,hidden:g.hidden}).then(function(x){return final(x)?{done:true,n:x.status===200?1:0}:RETRY})})}

/* j — ответ GET /api/data аккаунта (с его id). Не отклоняется никогда.
   → null (слияния не было или нечего менять) или {j: ответ с новыми данными кэшбэка или undefined, n: сколько частей изменено} */
export function mergeGuest(j){
  var id=j&&j.id;
  if(typeof id!=='string'||guestMerged(id))return Promise.resolve(null);
  var g=guestDump();
  if(!g.cb&&!g.ag&&!g.wf){guestMark(id);return Promise.resolve(null)}
  return Promise.all([doCb(j,g.cb),doAg(g.ag),doWf(g.wf)]).then(function(a){
    if(a.every(function(x){return x.done}))guestMark(id);
    var n=a[0].n+a[1].n+a[2].n;
    return n?{j:a[0].j,n:n}:null
  }).catch(function(){return null})}
