/* Даты и время. Всё считается по Москве (Europe/Moscow, UTC+3, без перехода на летнее время) */
export var MN=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
export var MG=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
export function pad(n){return(n<10?'0':'')+n}
export function mk(y,m){return y+'-'+pad(m)}
export function clock(){var p=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()),
    g=function(t){return+p.filter(function(x){return x.type===t})[0].value},y=g('year'),m=g('month'),dd=g('day');
  return{cur:mk(y,m),nxt:m===12?mk(y+1,1):mk(y,m+1),late:dd>=25,day:mk(y,m)+'-'+pad(dd)}}
export function label(k){var a=k.split('-');return MN[+a[1]-1]+' '+a[0]}
export function mskHour(){return parseInt(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',hour:'2-digit',hourCycle:'h23'}).format(new Date()),10)}
/* минуты от московской полуночи (для сравнения со слотом «после HH:MM») */
export function mskMins(){var p=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()),g=function(x){return parseInt(p.filter(function(y){return y.type===x})[0].value,10)};return g('hour')*60+g('minute')}
export function ymd(y,m,d){return y+'-'+pad(m)+'-'+pad(d)}
export function addDays(s,n){var a=s.split('-'),d=new Date(Date.UTC(+a[0],+a[1]-1,+a[2]+n));return ymd(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate())}
export function shiftM(k,n){var a=k.split('-'),d=new Date(Date.UTC(+a[0],+a[1]-1+n,1));return mk(d.getUTCFullYear(),d.getUTCMonth()+1)}
export function dLabel(s){var a=s.split('-');return+a[2]+' '+MG[+a[1]-1]+' '+a[0]}
