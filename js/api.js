/* Запросы к /api, состояние сессии и общий обработчик «сессия истекла» */
export var S={loggedIn:false,page:'main'};
var onFail=function(){};
export function onAuthFail(fn){onFail=fn}
export function authFail(){onFail()}
export function api(m,u,b,ka){return fetch(u,{method:m,credentials:'same-origin',keepalive:!!ka,headers:b?{'Content-Type':'application/json'}:{},body:b?JSON.stringify(b):undefined})}
