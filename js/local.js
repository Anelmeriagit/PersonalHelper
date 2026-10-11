/* Гостевой режим: «сервер в браузере». Пока аккаунта нет, api() (api.js) отправляет запросы сюда, а не в сеть:
   те же пути и формы ответов, что у настоящего API, но данные лежат в localStorage этого браузера и на сервер не уходят.
   Проверка значений та же, что на сервере; править обе части синхронно:
   кэшбэк (/api/data) — api/_lib.js (clean, cleanCustom, cleanBlocks, PART_RE) и api/data.js (PUT);
   агент (/api/agent) — api/agent.js (cleanApp, cleanRows, withAt, nextAt);
   Wi-Fi (/api/wifi, список сетей до 5) — api/wifi.js (cleanWifi, wifiString, normNets, ответы GET/PUT/DELETE), QR строит js/qr.js (парный файл к api/_qr.js): пароль сети на сервер не уходит.
   Остальные пути (напоминания, Telegram, вход) отвечают 401, как сервер без входа.
   Слияние гостевых данных с аккаунтом при входе через Google: чистые функции guestDump, mergeCb, mergeAg, mergeWf и метка «уже сливали» (guestMerged, guestMark) здесь,
   сетевая часть — merge.js. */
import {ls} from './util.js';
import {clock,shiftM} from './time.js';
import {BANKS,CATS,PCTS} from './cashback/state.js';
import {makeQr,utf8Bytes} from './qr.js';

var K_CB='g-cb',K_AG='g-ag',K_WF='g-wf',K_MG='g-mg',ACC_RE=/^[0-9a-f]{32}$/;
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

/* ---------- Wi-Fi (зеркало api/wifi.js; QR — js/qr.js) ---------- */
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
var NETS_MAX=5,NET_ID=/^[a-z0-9]{2,12}$/;
/* список сетей из записи: {nets:[...]} или прежний вид одной сети (id 'w1'); негодные и лишние сверх 5 пропускаются, негодный или повторный id заменяется на w1, w2… (зеркало normNets в api/wifi.js) */
function normNets(raw){if(!raw||typeof raw!=='object')return[];
  var list=Array.isArray(raw.nets)?raw.nets:raw.ssid!==undefined?[Object.assign({},raw,{id:'w1'})]:[],out=[],seen={};
  list.forEach(function(o){if(out.length>=NETS_MAX)return;var c=cleanWifi(o);if(!c.cfg)return;
    var id=o&&typeof o.id==='string'&&NET_ID.test(o.id)&&!seen[o.id]?o.id:null,i=1;
    if(!id){while(seen['w'+i])i++;id='w'+i}
    seen[id]=1;out.push({id:id,ssid:c.cfg.ssid,password:c.cfg.password,security:c.cfg.security,hidden:c.cfg.hidden})});
  return out}
function newNetId(nets){var a=new Uint8Array(4),id,i;
  do{crypto.getRandomValues(a);id='';for(i=0;i<4;i++)id+=('0'+a[i].toString(16)).slice(-2)}while(nets.some(function(n){return n.id===id}));return id}
/* ответ: {configured, nets:[{id,…,qr}]} */
function wifiView(nets){if(!nets.length)return{configured:false,nets:[]};
  return{configured:true,nets:nets.map(function(n){return Object.assign({},n,{qr:makeQr(wifiString(n))})})}}
function wfNets(){return normNets(read(K_WF))}
function wfSave(nets){return nets.length?write(K_WF,{nets:nets}):drop(K_WF)}
/* данные аккаунта становятся гостевыми: null или пустой список — сети нет (запись удаляется), иначе проверенные сети (v — ответ GET /api/wifi или прежний вид одной сети); false, если не записалось или ни одна не прошла проверку */
export function guestSetWf(v){if(v===null)return drop(K_WF);
  if(v&&Array.isArray(v.nets)&&!v.nets.length)return drop(K_WF);
  var nets=normNets(v);return nets.length?write(K_WF,{nets:nets}):false}
function wifiReq(m,b,u){
  if(m!=='GET'&&m!=='PUT'&&m!=='DELETE')return out(405,{error:'method'});
  var nets=wfNets(),next,id,q;
  if(m==='GET')return out(200,wifiView(nets));
  if(m==='DELETE'){
    q=/[?&]id=([^&]*)/.exec(String(u));id='';try{id=q?decodeURIComponent(q[1]):''}catch(e){}
    next=id?nets.filter(function(n){return n.id!==id}):nets.slice(1);
    if(next.length===nets.length)return out(200,wifiView(nets));
    return wfSave(next)?out(200,wifiView(next)):out(500,{error:'storage'})}
  var c=cleanWifi(b);
  if(!c.cfg)return out(400,{error:c.error});
  var add=b.add===true,bid=b.id;
  if((bid!==undefined&&typeof bid!=='string')||(add&&bid!==undefined))return out(400,{error:'bad'});
  var i;
  if(add){if(nets.length>=NETS_MAX)return out(400,{error:'limit'});next=nets.concat([Object.assign({id:newNetId(nets)},c.cfg)])}
  else{i=bid!==undefined?nets.map(function(n){return n.id}).indexOf(bid):0;
    if(bid!==undefined&&i<0)return out(404,{error:'nonet'});
    if(!nets.length)next=[Object.assign({id:newNetId(nets)},c.cfg)];
    else{next=nets.slice();next[i]=Object.assign({id:nets[i].id},c.cfg)}}
  var v=wifiView(next);
  if(JSON.stringify(next)===JSON.stringify(nets))return out(200,v);
  return wfSave(next)?out(200,v):out(500,{error:'storage'})}

/* ---------- слияние гостевых данных с аккаунтом при входе через Google (часть 4; сеть — merge.js) ----------
   Правило: на конфликте побеждает аккаунт, гость заполняет пробелы. Выполняется один раз на аккаунт в этом браузере (метка g-mg). */
/* гостевые данные как есть; часть, которой у гостя нет, — null (кэшбэк: пустой документ; агент: список ни разу не сохранялся) */
export function guestDump(){var d=cbDoc(),ag=read(K_AG),wf=wfNets();
  return{cb:Object.keys(d.months).length||d.custom.length?pub(d):null,
    ag:ag&&Array.isArray(ag.rows)&&ag.rows.length?cleanRows(ag.rows,true).slice(0,AG_MAX):null,
    wf:wf.length?wf.map(function(n){return{ssid:n.ssid,password:n.password,security:n.security,hidden:n.hidden}}):null}}
/* кэшбэк: месяц и банк, которых нет в аккаунте, копируются (месяц вне окна «прошлый … +2», которого у аккаунта нет, сервер создать не даст, он пропускается); свои категории объединяются (аккаунт первым, до 30).
   → {data: итоговый документ, parts: ключи изменённых частей (месяцы и 'custom')} */
export function mergeCb(acc,gst){
  var a=clean(acc),g=clean(gst),cur=clock().cur,lo=shiftM(cur,-1),hi=shiftM(cur,2),months=JSON.parse(JSON.stringify(a.months)),low=Object.create(null);
  a.custom.forEach(function(c){low[c.toLowerCase()]=c});
  /* своя категория гостя, совпавшая с категорией аккаунта в другом регистре, записывается как у аккаунта (иначе проверка отбросила бы строку) */
  function spell(items){return items.map(function(i){var c=low[String(i.cat).toLowerCase()];return{cat:c||i.cat,pct:i.pct}})}
  Object.keys(g.months).forEach(function(mo){
    if(!has(months,mo)&&!(mo>=lo&&mo<=hi))return;
    var mine=months[mo]||[],banks=mine.map(function(b){return b.bank}),
      add=g.months[mo].filter(function(b){return banks.indexOf(b.bank)<0}).map(function(b){return{bank:b.bank,items:spell(b.items)}});
    if(add.length)months[mo]=mine.concat(add)});
  var m=clean({months:months,custom:a.custom.concat(g.custom)}),parts=[];
  if(JSON.stringify(m.custom)!==JSON.stringify(a.custom))parts.push('custom');
  Object.keys(m.months).forEach(function(mo){if(JSON.stringify(m.months[mo])!==JSON.stringify(a.months[mo]||[]))parts.push(mo)});
  return{data:m,parts:parts}}
/* агент: строка гостя с тем же названием (без учёта регистра, по порядку) совпадает со строкой аккаунта: побеждает аккаунт, но если у неё нет времени, берётся время гостя;
   строки без пары добавляются в конец, пока их не станет 12. → {rows, changed} */
export function mergeAg(acc,gst){
  var rows=cleanRows(acc,true).slice(0,AG_MAX),used=[],extra=[],changed=false;
  cleanRows(gst,true).forEach(function(g){var i=-1,k;
    for(k=0;k<rows.length;k++)if(used.indexOf(k)<0&&rows[k].app.toLowerCase()===g.app.toLowerCase()){i=k;break}
    if(i<0){extra.push(g);return}
    used.push(i);
    var r=rows[i];
    if((r.h===null||r.m===null)&&g.h!==null&&g.m!==null){rows[i]={id:r.id,app:r.app,h:g.h,m:g.m,at:null};changed=true}});
  extra.forEach(function(g){if(rows.length>=AG_MAX)return;rows.push({id:agId(),app:g.app,h:g.h,m:g.m,at:null});changed=true});
  return{rows:rows,changed:changed}}
/* Wi-Fi: сети гостя, которых нет у аккаунта (по названию, защите и паролю), добавляются, пока в аккаунте не станет 5; аккаунт первым, повтор ничего не задваивает.
   acc — сети аккаунта (ответ GET /api/wifi), gst — сети гостя (guestDump().wf) → {add: сети для добавления} */
function wfKey(n){return JSON.stringify([n.ssid,n.security,n.security==='nopass'?'':n.password])}
export function mergeWf(acc,gst){var a=Array.isArray(acc)?acc:[],have={},add=[];
  a.forEach(function(n){have[wfKey(n)]=1});
  (Array.isArray(gst)?gst:[]).forEach(function(g){var k=wfKey(g);if(have[k]||a.length+add.length>=NETS_MAX)return;have[k]=1;add.push(g)});
  return{add:add}}
/* метка «с этим аккаунтом уже сливали»: список id (32 hex), последние 20; id аккаунта приходит в ответе GET /api/data */
export function guestMerged(id){var a=read(K_MG);return Array.isArray(a)&&a.indexOf(id)>-1}
export function guestMark(id){if(typeof id!=='string'||!ACC_RE.test(id))return false;
  var a=read(K_MG);a=Array.isArray(a)?a.filter(function(v){return typeof v==='string'&&ACC_RE.test(v)&&v!==id}):[];a.push(id);return write(K_MG,a.slice(-20))}

/* запрос гостя: ответ Response (как fetch). Всё, что не гостевое (напоминания, Telegram), отвечает 401 «нужен вход». */
export function guestApi(m,u,b){
  var p=String(u).split('?')[0],r=p==='/api/data'?dataReq(m,b):p==='/api/agent'?agentReq(m,b):p==='/api/wifi'?wifiReq(m,b,u):out(401,{error:'auth'});
  return Promise.resolve(r)}
