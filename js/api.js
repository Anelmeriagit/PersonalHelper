/* Запросы к /api, состояние сессии и общий обработчик «сессия истекла» */
export var S={loggedIn:false,page:'main',at:{}};
/* Как часто можно обновлять раздел при возврате на вкладку (одна константа на все разделы: кэшбэк, напоминания, WiFi, агент).
   Каждое чтение с сервера стоит команд Upstash Redis (бесплатный предел 500 тыс. в месяц). Обновление при входе, переходе на раздел,
   смене месяца и после конфликта сохранения это ограничение не касается. */
export var REFRESH_MS=5*60*1000;
/* S.at[раздел] — когда раздел последний раз успешно получил данные с сервера; при выходе из аккаунта сбрасывается (main.js, showLogin) */
export function fresh(k){var t=S.at[k];return !!t&&Date.now()-t<REFRESH_MS}
export function stamp(k){S.at[k]=Date.now()}
var onFail=function(){};
export function onAuthFail(fn){onFail=fn}
export function authFail(){onFail()}
export function api(m,u,b,ka){return fetch(u,{method:m,credentials:'same-origin',keepalive:!!ka,headers:b?{'Content-Type':'application/json'}:{},body:b?JSON.stringify(b):undefined})}
