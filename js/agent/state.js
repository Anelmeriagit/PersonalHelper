/* «Агент»: константы, общее состояние A и чистые помощники (время, копирование строк) */
import {$} from '../util.js';

export var AG_APPS=[{id:'app',t:'App'},{id:'opera',t:'Opera'},{id:'mozilla',t:'Mozilla'},{id:'edge',t:'Edge'}],AG_MAX=12,AG_GRACE=30*60000,
/* пауза между правкой и сохранением (меньше записей в Redis); при уходе со вкладки сохраняется сразу (agLeave) */
AG_SAVE_MS=1800;
/* ag — загруженные строки страницы; n — строки для уведомлений вне страницы «Агент»; render — отрисовка страницы (задаёт index.js) */
export var A={ag:null,timer:0,saving:false,again:false,noteT:0,drag:null,busy:false,cu:[],n:null,nAt:0,nBusy:false,wake:0,sw:false,fm:null,render:null};
var agMsg=$('agMsg');
export function agId(){return Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4)}
export function agTwo(n){return n<10?'0'+n:''+n}
export function agNote(t,keep){agMsg.textContent=t;clearTimeout(A.noteT);if(t&&!keep)A.noteT=setTimeout(function(){agMsg.textContent=''},2500)}
export function agRow(id){for(var i=0;i<A.ag.rows.length;i++)if(A.ag.rows[i].id===id)return A.ag.rows[i];return null}
export function agCopy(rows){return(rows||[]).map(function(r){return{id:r.id,app:r.app,h:r.h===undefined?null:r.h,m:r.m===undefined?null:r.m,at:r.at||null}})}
export function agNextAt(h,m){var n=Date.now(),d=new Date(n+10800000),at=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),h,m)-10800000;return at<=n?at+864e5:at}
export function agDay(ms){return new Date(ms+10800000).toISOString().slice(0,10)}
export function agUntil(ms){var t=Math.max(1,Math.ceil(ms/60000)),h=Math.floor(t/60),m=t%60;return h?(m?h+' ч '+m+' мин':h+' ч'):t+' мин'}
export function agName(app){for(var i=0;i<AG_APPS.length;i++)if(AG_APPS[i].id===app)return AG_APPS[i].t;return app}
