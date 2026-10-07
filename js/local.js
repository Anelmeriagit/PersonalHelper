/* Гостевой режим: «сервер в браузере». Пока аккаунта нет, api() (api.js) отправляет запросы сюда, а не в сеть:
   те же пути и формы ответов, что у настоящего API, но данные лежат в localStorage этого браузера и на сервер не уходят.
   Проверка значений та же, что на сервере (api/_lib.js: clean, cleanCustom, cleanBlocks, PART_RE, окно месяцев; api/data.js, PUT): править обе части синхронно.
   Сейчас здесь только кэшбэк (/api/data); остальные пути отвечают 401, как сервер без входа. */
import {ls} from './util.js';
import {clock,shiftM} from './time.js';
import {BANKS,CATS,PCTS} from './cashback/state.js';

var K_CB='g-cb';
var MONTH_RE=/^\d{4}-(0[1-9]|1[0-2])$/,PART_RE=/^(\d{4}-(0[1-9]|1[0-2])|custom)$/,BAD_CAT=/[<>"'`&\\\u0000-\u001f]/;

function has(o,k){return Object.prototype.hasOwnProperty.call(o,k)}
function out(status,obj){return new Response(JSON.stringify(obj),{status:status,headers:{'Content-Type':'application/json'}})}
function read(k){var s=ls(k);if(!s)return null;try{var o=JSON.parse(s);return o&&typeof o==='object'?o:null}catch(e){return null}}
function write(k,o){try{localStorage.setItem(k,JSON.stringify(o));return true}catch(e){return false}}

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

/* запрос гостя: ответ Response (как fetch). Всё, что не гостевое (напоминания, Telegram, WiFi и агент пока), отвечает 401 «нужен вход». */
export function guestApi(m,u,b){
  var p=String(u).split('?')[0];
  return Promise.resolve(p==='/api/data'?dataReq(m,b):out(401,{error:'auth'}))}
