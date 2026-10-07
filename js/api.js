/* Запросы к /api, состояние сессии и общий обработчик «сессия истекла».
   S.loggedIn — разделы активны (аккаунт или гость), S.acct — есть настоящий аккаунт с сессией на сервере. Без аккаунта api() не ходит в сеть: гостевые запросы отвечает js/local.js. */
import {guestApi} from './local.js';
export var S={loggedIn:false,acct:false,page:'main',at:{}};
/* Как часто можно обновлять раздел при возврате на вкладку (одна константа на все разделы: кэшбэк, напоминания, WiFi, агент).
   Каждое чтение с сервера стоит команд Upstash Redis (бесплатный предел 500 тыс. в месяц). Обновление при входе, переходе на раздел,
   смене месяца и после конфликта сохранения это ограничение не касается. */
export var REFRESH_MS=5*60*1000;
/* S.at[раздел] — когда раздел последний раз успешно получил данные; при смене режима (аккаунт ↔ гость) сбрасывается (main.js) */
export function fresh(k){var t=S.at[k];return !!t&&Date.now()-t<REFRESH_MS}
export function stamp(k){S.at[k]=Date.now()}
var onFail=function(){};
export function onAuthFail(fn){onFail=fn}
export function authFail(){onFail()}
/* настоящий запрос на сервер (проверка сессии при открытии сайта) */
export function net(m,u,b,ka){return fetch(u,{method:m,credentials:'same-origin',keepalive:!!ka,headers:b?{'Content-Type':'application/json'}:{},body:b?JSON.stringify(b):undefined})}
/* запрос раздела: аккаунт — на сервер, гость — в хранилище браузера */
export function api(m,u,b,ka){return S.acct?net(m,u,b,ka):guestApi(m,u,b)}
