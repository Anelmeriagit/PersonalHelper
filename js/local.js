/* Гостевой режим: «сервер в браузере». Пока аккаунта нет, api() (api.js) отправляет запросы сюда, а не в сеть:
   те же пути и формы ответов, что у настоящего API, но данные лежат в localStorage этого браузера и на сервер не уходят.
   Проверка значений та же, что на сервере; править обе части синхронно:
   кэшбэк (/api/data) — api/_lib.js (clean, cleanCustom, cleanBlocks, PART_RE) и api/data.js (PUT);
   агент (/api/agent) — api/agent.js (cleanApp, cleanRows, withAt, nextAt);
   WiFi (/api/wifi) — api/wifi.js (cleanWifi, wifiString), QR строит js/qr.js (парный файл к api/_qr.js): пароль сети на сервер не уходит.
   Остальные пути (напоминания, Telegram, вход) отвечают 401, как сервер без входа. */
import {ls} from './util.js';
import {clock,shiftM} from './time.js';
import {BANKS,CATS,PCTS} from './cashback/state.js';
import {makeQr,utf8Bytes} from './qr.js';

var K_CB='g-cb',K_AG='g-ag',K_WF='g-wf';
var MONTH_RE=/^\d{4}-(0[1-9]|1[0-2])$/,PART_RE=/^(\d{4}-(0[1-9]|1[0-2])|custom)$/,BAD_CAT=/[<>"'`&\\\u0000-\u001f]/;

function has(o,k){return Object.prototype.hasOwnProperty.call(o,k)}
function out(status,obj){return new Response(JSON.stringify(obj),{status:status,headers:{'Content-Type':'application/json'}})}
function read(k){var s=ls(k);if(!s)return null;try{var o=JSON.parse(s);return o&&typeof o==='object'?o:null}catch(e){return null}}
function write(k,o){try{localStorage.setItem(k,JSON.stringify(o));return true}catch(e){return false}}
function drop(k){try{localStorage.removeItem(k);return true}catch(e){return false}}

/* ---------- проверка значений (зеркало api/_lib.js) ---------- */
function cleanCustom(list){var out=[],seen=Object.create(null);
  CATS.forEach(function(c){seen[c.toLowerCase()]=1});
  (Array.isArray(list)?list:[]).forEach(function(v){
    if(out.length>=30||typeof v!=='string')return;
    var t=v.replace(/\s+/g,' ').trim(),k=t.toLowerCase();
    if(!t||t.length>40||BAD_CAT.test(t)||has(seen,k))return;
    seen[k]=1;out.push(t)});
  return out}
function cleanBlocks(list,allowed){var seen=Object.create(null);
  return(Array.isArray(list)?list:[]).filter(function(b){return b&&typeof b.bank==='string'&&has(BANKS,b.bank)&&!has(seen,b.bank)&&(seen[b.bank]=1)})
    .map(function(b){return{bank:b.bank,items:(Array.isArray(b.items)?b.items:[]).filter(function(i){return i&&typeof i.cat==='string'&&has(allowed,i.cat)&&PCTS.indexOf(i.pct)>-1}).slice(0,60).map(function(i){return{cat:i.cat,pct:i.pct}})}})}
function clean(d){var custom=cleanCustom(d&&d.custom),allowed=Object.create(null),months={},src=d&&d.months&&typeof d.months==='object'?d.months:{};
  CATS.concat(custom).forEach(function(c){allowed[c]=1});
  Object.keys(src).filter(function(k){return MONTH_RE.test(k)}).sort().slice(-60).forEach(function(k){var v=cleanBlocks(src[k],allowed);if(v.length)months[k]=v});
  return{months:months,custom:custom}}
function cleanRev(r){var o={};
  Object.keys(r&&typeof r==='object'?r:{}).forEach(function(k){if(PART_RE.test(k)&&Number.isInteger(r[k])&&r[k]>=0)o[k]=r[k]});
  return o}

/* ---------- документ кэшбэков гостя ---------- */
function cbDoc(){var raw=read(K_CB)||{},d=clean(raw);d.rev=cleanRev(raw.rev);return d}
function pub(d){return{months:d.months,custom:d.custom}}
/* то же, что читает сайт: {data:{months,custom}, rev} */
export function guestGetCb(){var d=cbDoc();return{data:pub(d),rev:d.rev}}
/* данные аккаунта становятся гостевыми (выход, конец сессии): документ заменяется целиком, версии частей с нуля; false, если браузер не дал записать */
export function guestSetCb(data){var d=clean(data);d.rev={};return write(K_CB,d)}

function dataReq(m,b){
  if(m==='GET'){var d=cbDoc();return out(200,{user:'',name:'',data:pub(d),rev:d.rev})}
  if(m!=='PUT')return out(405,{error:'method'});
  var parts=b&&typeof b.parts==='object'&&b.parts?b.parts:{},names=Object.keys(parts);
  var cur=clock().cur,lo=shiftM(cur,-1),hi=shiftM(cur,2);
  if(!names.length||names.length>130||names.some(function(k){return !PART_RE.test(k)||!parts[k]||!Number.isInteger(parts[k].base)||!Array.isArray(parts[k].value)}))return out(400,{error:'bad request'});
  var doc=cbDoc();
  /* новые месяцы только в окне «прошлый … +2»; существующие (история) менять можно всегда */
  if(names.some(function(k){return k!=='custom'&&!(k>=lo&&k<=hi)&&!doc.months[k]}))return out(400,{error:'bad request'});
  var bad=names.filter(function(k){return parts[k].base!==(doc.rev[k]||0)});
  if(bad.length)return out(409,{error:'conflict',parts:bad,data:pub(doc),rev:doc.rev});
  var merged={months:JSON.parse(JSON.stringify(doc.months)),custom:doc.custom};
  names.forEach(function(k){if(k==='custom')merged.custom=parts[k].value;else merged.months[k]=parts[k].value});
  var next=clean(merged);next.rev=Object.assign({},doc.rev);
  names.forEach(function(k){next.rev[k]=(doc.rev[k]||0)+1});
  return write(K_CB,next)?out(200,{ok:true,rev:next.rev}):out(500,{error:'storage'})}

/* ---------- агент (зеркало api/agent.js) ---------- */
var AGENT_APPS=['app','opera','mozilla','edge'],AG_NAME_MAX=40,AG_MAX=12,ID_RE=/^[a-z0-9]{1,16}$/,MSK_MS=3*3600e3;
function agId(){return Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4)}
function agDefaults(){return AGENT_APPS.map(function(a){return{id:a,app:a,h:null,m:null,at:null}})}
/* ближайший момент (мс, UTC), когда в Москве будет h:m; если он уже наступил, то завтра */
function nextAt(h,m,now){var d=new Date(now+MSK_MS),at=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),h,m)-MSK_MS;return at<=now?at+864e5:at}
function cleanApp(v){if(typeof v!=='string')return null;
  var t=v.replace(/\s+/g,' ').trim();
  if(!t||t.length>AG_NAME_MAX||BAD_CAT.test(t))return null;
  return AGENT_APPS.indexOf(t.toLowerCase())>-1?t.toLowerCase():t}
function cleanRows(list,keepAt){var out=[],seen=Object.create(null);
  (Array.isArray(list)?list:[]).forEach(function(r){
    var app=r&&typeof r==='object'?cleanApp(r.app):null;
    if(!app)return;
    var id=typeof r.id==='string'&&ID_RE.test(r.id)&&!has(seen,r.id)?r.id:agId();
    seen[id]=1;
    var h=Number.isInteger(r.h)&&r.h>=0&&r.h<=23?r.h:null,m=Number.isInteger(r.m)&&r.m>=0&&r.m<=50&&r.m%10===0?r.m:null,
      at=keepAt&&h!==null&&m!==null&&Number.isSafeInteger(r.at)&&r.at>0?r.at:null;
    out.push({id:id,app:app,h:h,m:m,at:at})});
  return out}
/* прежний `at`, если ч:мин у строки не менялись, иначе новый; без ч:мин — null */
function withAt(rows,prev,now){var old=Object.create(null);prev.forEach(function(r){old[r.id]=r});
  return rows.map(function(r){
    if(r.h===null||r.m===null)return{id:r.id,app:r.app,h:r.h,m:r.m,at:null};
    var o=has(old,r.id)?old[r.id]:null;
    return{id:r.id,app:r.app,h:r.h,m:r.m,at:o&&o.h===r.h&&o.m===r.m&&o.at?o.at:nextAt(r.h,r.m,now)}})}
function agRows(){var raw=read(K_AG);return raw&&Array.isArray(raw.rows)?cleanRows(raw.rows,true).slice(0,AG_MAX):agDefaults()}
/* строки агента гостя */
export function guestGetAg(){return agRows()}
/* данные аккаунта становятся гостевыми (выход, конец сессии): список заменяется целиком; false, если браузер не дал записать */
export function guestSetAg(rows){return write(K_AG,{rows:cleanRows(rows,true).slice(0,AG_MAX)})}
function agentReq(m,b){
  if(m!=='GET'&&m!=='PUT')return out(405,{error:'method'});
  if(m==='GET')return out(200,{rows:agRows()});
  if(!b||!Array.isArray(b.rows))return out(400,{error:'bad request'});
  if(b.rows.length>AG_MAX)return out(400,{error:'limit'});
  var rows=withAt(cleanRows(b.rows),agRows(),Date.now());
  return write(K_AG,{rows:rows})?out(200,{rows:rows}):out(500,{error:'storage'})}

/* ---------- WiFi (зеркало api/wifi.js; QR — js/qr.js) ---------- */
var SEC=['WPA','WEP','nopass'],W_BAD=/[\u0000-\u001f\u007f]/,HEX=/^[0-9a-fA-F]+$/;
/* экранирование по формату WIFI:... — символы \ ; , : " предваряются обратным слэшем */
function wesc(s){return String(s).replace(/([\\;,:"])/g,'\\$1')}
function wifiString(c){var open=c.security==='nopass';
  return 'WIFI:T:'+c.security+';S:'+wesc(c.ssid)+';'+(open?'':'P:'+wesc(c.password)+';')+'H:'+(c.hidden?'true':'false')+';;'}
/* → {cfg} или {error:'security'|'ssid'|'password'}: название до 32 байт; пароль WPA 8–63 символа или 64 hex; WEP 5 или 13 символов либо 10 или 26 hex */
function cleanWifi(b){var o=b&&typeof b==='object'?b:{},security=SEC.indexOf(o.security)>-1?o.security:null;
  if(!security)return{error:'security'};
  var ssid=typeof o.ssid==='string'?o.ssid:'';
  if(!ssid.trim()||utf8Bytes(ssid).length>32||W_BAD.test(ssid))return{error:'ssid'};
  var hidden=o.hidden===true;
  if(security==='nopass')return{cfg:{ssid:ssid,password:'',security:security,hidden:hidden}};
  var pw=typeof o.password==='string'?o.password:'';
  if(W_BAD.test(pw))return{error:'password'};
  var n=pw.length,ok=security==='WPA'?(n>=8&&n<=63)||(n===64&&HEX.test(pw)):n===5||n===13||((n===10||n===26)&&HEX.test(pw));
  return ok?{cfg:{ssid:ssid,password:pw,security:security,hidden:hidden}}:{error:'password'}}
function wifiView(cfg){return cfg?{configured:true,ssid:cfg.ssid,password:cfg.password,security:cfg.security,hidden:cfg.hidden,qr:makeQr(wifiString(cfg))}:{configured:false}}
function wfCfg(){var raw=read(K_WF),c=raw?cleanWifi(raw):null;return c&&c.cfg}
/* данные аккаунта становятся гостевыми: null — сети нет (запись удаляется), иначе проверенные данные сети; false, если не записалось */
export function guestSetWf(v){if(v===null)return drop(K_WF);var c=cleanWifi(v);return c.cfg?write(K_WF,c.cfg):false}
function wifiReq(m,b){
  if(m!=='GET'&&m!=='PUT'&&m!=='DELETE')return out(405,{error:'method'});
  if(m==='DELETE')return drop(K_WF)?out(200,{configured:false}):out(500,{error:'storage'});
  if(m==='GET')return out(200,wifiView(wfCfg()));
  var c=cleanWifi(b);
  if(!c.cfg)return out(400,{error:c.error});
  var v=wifiView(c.cfg);
  return write(K_WF,c.cfg)?out(200,v):out(500,{error:'storage'})}

/* запрос гостя: ответ Response (как fetch). Всё, что не гостевое (напоминания, Telegram), отвечает 401 «нужен вход». */
export function guestApi(m,u,b){
  var p=String(u).split('?')[0],r=p==='/api/data'?dataReq(m,b):p==='/api/agent'?agentReq(m,b):p==='/api/wifi'?wifiReq(m,b):out(401,{error:'auth'});
  return Promise.resolve(r)}
