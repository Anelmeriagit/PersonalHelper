/* Список часовых поясов для выбора и подписи пояса (часть 4). Без DOM: проверяется в tests/tz-site.test.mjs.
   Список короткий (крупные города по смещениям); пояса устройства и аккаунта, которых в нём нет, добавляются отдельной строкой. Сервер принимает любое название IANA. */
import {cleanTz,sameTz,offsetAt} from './tz.js';
var LIST=[['Pacific/Honolulu','Гонолулу'],['America/Anchorage','Анкоридж'],['America/Los_Angeles','Лос-Анджелес'],['America/Denver','Денвер'],['America/Chicago','Чикаго'],
  ['America/New_York','Нью-Йорк'],['America/Halifax','Галифакс'],['America/Sao_Paulo','Сан-Паулу'],['Atlantic/Azores','Азорские острова'],['UTC','UTC'],['Europe/London','Лондон'],
  ['Europe/Berlin','Берлин'],['Europe/Paris','Париж'],['Europe/Rome','Рим'],['Europe/Madrid','Мадрид'],['Europe/Warsaw','Варшава'],['Africa/Johannesburg','Йоханнесбург'],['Europe/Athens','Афины'],
  ['Europe/Helsinki','Хельсинки'],['Africa/Cairo','Каир'],['Asia/Jerusalem','Иерусалим'],['Europe/Kaliningrad','Калининград'],['Europe/Istanbul','Стамбул'],['Europe/Minsk','Минск'],
  ['Europe/Moscow','Москва'],['Asia/Riyadh','Эр-Рияд'],['Asia/Tehran','Тегеран'],['Asia/Dubai','Дубай'],['Europe/Samara','Самара'],['Asia/Baku','Баку'],['Asia/Tbilisi','Тбилиси'],
  ['Asia/Yerevan','Ереван'],['Asia/Yekaterinburg','Екатеринбург'],['Asia/Tashkent','Ташкент'],['Asia/Almaty','Алматы'],['Asia/Kolkata','Индия (Дели)'],['Asia/Kathmandu','Катманду'],
  ['Asia/Bishkek','Бишкек'],['Asia/Omsk','Омск'],['Asia/Novosibirsk','Новосибирск'],['Asia/Krasnoyarsk','Красноярск'],['Asia/Bangkok','Бангкок'],['Asia/Irkutsk','Иркутск'],
  ['Asia/Shanghai','Шанхай'],['Asia/Singapore','Сингапур'],['Australia/Perth','Перт'],['Asia/Tokyo','Токио'],['Asia/Seoul','Сеул'],['Asia/Yakutsk','Якутск'],['Australia/Sydney','Сидней'],
  ['Asia/Vladivostok','Владивосток'],['Asia/Magadan','Магадан'],['Pacific/Auckland','Окленд'],['Asia/Kamchatka','Камчатка']];
/* подпись смещения: UTC+3, UTC+5:45, UTC-7 (по моменту now: летнее время учитывается) */
export function utcText(tz,now){
  var m=Math.round(offsetAt(now===undefined?Date.now():now,tz)/60000),s=m<0?'-':'+',a=Math.abs(m),h=Math.floor(a/60),r=a%60;
  return 'UTC'+(m===0?'':s+h+(r?':'+(r<10?'0':'')+r:''))}
function city(tz){var p=String(tz).split('/'),c=p[p.length-1].replace(/_/g,' ');return c}
/* название пояса для показа: русское из списка, иначе город из названия IANA */
export function tzName(tz){for(var i=0;i<LIST.length;i++)if(sameTz(LIST[i][0],tz))return LIST[i][1];return city(cleanTz(tz)||tz)}
/* «Берлин, UTC+2» */
export function tzShort(tz,now){return tzName(tz)+', '+utcText(tz,now)}
/* варианты для выбора: [{id, t}] по смещению (потом по названию); selected и device добавляются, если их нет в списке */
export function tzChoices(selected,device,now){
  now=now===undefined?Date.now():now;
  var rows=LIST.filter(function(x){return !!cleanTz(x[0])}).map(function(x){return{id:x[0],name:x[1]}});
  [selected,device].forEach(function(t){var c=cleanTz(t);if(c&&!rows.some(function(r){return sameTz(r.id,c)}))rows.push({id:c,name:city(c)})});
  rows.forEach(function(r){r.off=offsetAt(now,r.id)});
  rows.sort(function(a,b){return a.off-b.off||(a.name<b.name?-1:a.name>b.name?1:0)});
  return rows.map(function(r){return{id:r.id,t:r.name+' ('+utcText(r.id,now)+')'}})}
/* id из списка вариантов, соответствующий tz (то же название под другим написанием тоже подходит); '' если не нашёлся */
export function tzPick(choices,tz){for(var i=0;i<choices.length;i++)if(sameTz(choices[i].id,tz))return choices[i].id;return''}
