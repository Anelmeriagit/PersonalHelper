/* Часовые пояса сайта (этап 5, «Часовые пояса», часть 4). Парный файл к api/_tz.js (cleanTz, nowIn, offsetAt, zonedToMs, dayEndIn) и к nextAt из api/agent.js:
   результат тот же, менять только вместе (tests/tz-site.test.mjs сверяет их на многих поясах и моментах). Пояс — название IANA ('Europe/Berlin'), не смещение:
   летнее время считает Intl. Нет пояса = DEFAULT_TZ (Москва). Без DOM, ES5. */
export var DEFAULT_TZ='Europe/Moscow';
var MOSCOW_MS=3*3600e3,fmts={};
function fmt(tz){var f=fmts[tz];
  if(!f){f=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});fmts[tz]=f}
  return f}
function part(p,t){for(var i=0;i<p.length;i++)if(p[i].type===t)return p[i].value;return''}
/* название → каноническое название или null (только «Область/Город» и 'UTC') */
export function cleanTz(v){
  if(typeof v!=='string')return null;
  var s=v.trim();
  if(s.length>64)return null;
  if(s!=='UTC'&&!/^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(s))return null;
  try{return new Intl.DateTimeFormat('en-US',{timeZone:s}).resolvedOptions().timeZone}catch(e){return null}}
/* один и тот же пояс под разными названиями (Asia/Kolkata и Asia/Calcutta) */
export function sameTz(a,b){var x=cleanTz(a),y=cleanTz(b);return !!x&&x===y}
/* пояс устройства (каноническое название) или null, если браузер его не назвал */
export function deviceTz(){try{return cleanTz(new Intl.DateTimeFormat().resolvedOptions().timeZone)}catch(e){return null}}
/* → {month:'YYYY-MM', date:'YYYY-MM-DD', hour, minute} — настенное время пояса */
export function nowIn(tz,d){
  var p=fmt(tz||DEFAULT_TZ).formatToParts(d||new Date(Date.now())),month=part(p,'year')+'-'+part(p,'month');
  return{month:month,date:month+'-'+part(p,'day'),hour:parseInt(part(p,'hour'),10),minute:parseInt(part(p,'minute'),10)}}
/* смещение пояса от UTC в мс на момент ms (восток — плюс) */
export function offsetAt(ms,tz){
  tz=tz||DEFAULT_TZ;
  if(tz===DEFAULT_TZ)return MOSCOW_MS;
  var p=fmt(tz).formatToParts(new Date(ms));
  function g(t){return parseInt(part(p,t),10)}
  return Date.UTC(g('year'),g('month')-1,g('day'),g('hour'),g('minute'),g('second'))-Math.floor(ms/1000)*1000}
/* момент (мс, UTC), когда часы пояса показывают date ('YYYY-MM-DD') и minutes минут от полуночи */
export function zonedToMs(date,minutes,tz){
  tz=tz||DEFAULT_TZ;
  var wall=Date.parse(date+'T00:00:00Z')+minutes*60000;
  if(tz===DEFAULT_TZ)return wall-MOSCOW_MS;
  var first=wall-offsetAt(wall,tz);
  return wall-offsetAt(first,tz)}
/* ближайший момент (мс, UTC), когда часы пояса покажут h:m; наступившее время — следующие сутки по календарю пояса (парно api/agent.js nextAt) */
export function nextAt(h,m,now,tz){
  tz=tz||DEFAULT_TZ;
  var today=nowIn(tz,new Date(now)).date,at=zonedToMs(today,h*60+m,tz);
  if(at>now)return at;
  return zonedToMs(new Date(Date.parse(today+'T00:00:00Z')+864e5).toISOString().slice(0,10),h*60+m,tz)}
/* окно новых месяцев для кэшбэка, как у сервера (api/_lib.js monthWindow): от «прошлого» по UTC−12 до «+2» по UTC+14 */
function ym(ms){var d=new Date(ms);return d.getUTCFullYear()+'-'+(d.getUTCMonth()<9?'0':'')+(d.getUTCMonth()+1)}
function shiftYm(k,n){var a=k.split('-'),d=new Date(Date.UTC(+a[0],+a[1]-1+n,1));return d.getUTCFullYear()+'-'+(d.getUTCMonth()<9?'0':'')+(d.getUTCMonth()+1)}
export function monthWindow(now){now=now===undefined?Date.now():now;return{lo:shiftYm(ym(now-12*3600e3),-1),hi:shiftYm(ym(now+14*3600e3),2)}}
/* строки агента в новом поясе: `at` тот же, ч:мин по часам нового пояса, минута округляется вниз до сетки 10 минут; строка без `at` сначала получает его по прежнему поясу
   (парно retimeRows в api/agent.js) */
export function retimeRows(rows,oldTz,newTz,now){
  now=now===undefined?Date.now():now;
  return rows.map(function(r){
    if(r.h===null||r.m===null)return r;
    var at=r.at||nextAt(r.h,r.m,now,oldTz),w=nowIn(newTz,new Date(at));
    return{id:r.id,app:r.app,h:w.hour,m:Math.floor(w.minute/10)*10,at:at}})}
