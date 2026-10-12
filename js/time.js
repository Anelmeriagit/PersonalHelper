/* Даты и время. Считаются по часовому поясу текущего режима (этап 5, «Часовые пояса», часть 4): у аккаунта — его пояс (useTz при входе и после смены в настройках),
   у гостя — пояс устройства (main.js). Пока пояс не задан — Москва (DEFAULT_TZ), как было до поясов. Пояса и их арифметика — js/tz.js (пара api/_tz.js). */
import {DEFAULT_TZ,nowIn} from './tz.js';
var TZ=DEFAULT_TZ;
export function useTz(tz){TZ=tz||DEFAULT_TZ}
export function curTz(){return TZ}
export var MN=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
export var MG=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
export function pad(n){return(n<10?'0':'')+n}
export function mk(y,m){return y+'-'+pad(m)}
export function clock(){var n=nowIn(TZ),a=n.date.split('-'),y=+a[0],m=+a[1],dd=+a[2];
  return{cur:mk(y,m),nxt:m===12?mk(y+1,1):mk(y,m+1),late:dd>=25,day:n.date}}
export function label(k){var a=k.split('-');return MN[+a[1]-1]+' '+a[0]}
/* минуты от полуночи по часам пояса (для сравнения со слотом «после HH:MM») */
export function nowMins(){var n=nowIn(TZ);return n.hour*60+n.minute}
export function ymd(y,m,d){return y+'-'+pad(m)+'-'+pad(d)}
export function addDays(s,n){var a=s.split('-'),d=new Date(Date.UTC(+a[0],+a[1]-1,+a[2]+n));return ymd(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate())}
export function shiftM(k,n){var a=k.split('-'),d=new Date(Date.UTC(+a[0],+a[1]-1+n,1));return mk(d.getUTCFullYear(),d.getUTCMonth()+1)}
export function dLabel(s){var a=s.split('-');return+a[2]+' '+MG[+a[1]-1]+' '+a[0]}
