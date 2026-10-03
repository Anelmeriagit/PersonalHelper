/* «Напоминания»: постоянные (зашиты в код, дублируют REMINDERS в api/_bot.js), настройки и загрузка с сервера */
import {$} from '../util.js';
import {api,S,authFail} from '../api.js';
import {R,NM} from './state.js';
import {listsRender,initLists} from './lists.js';

var remBody=$('remBody'),remMsg=$('remMsg'),remWarn=$('remWarn');
var REM=[
  {id:'cashback',t:'Выбор кешбэка',d:'25 и 28 числа около 18:00, а если не отмечено — ещё раз на следующий день. Напоминает заполнить категории на следующий месяц.',w:['denis','zhanna']},
  {id:'meters',t:'Счётчики',d:'С 23 числа каждый день около 18:00, пока каждый не нажмёт «Готово».',w:['denis','zhanna']},
  {id:'halva',t:'Потратить Халву',d:'7, 12, 17, 22 и 27 числа около 14:00, пока не нажато «Всё потрачено».',w:['denis','zhanna']},
  {id:'mortgage',t:'Закинуть ипотеку',d:'22 числа около 14:00, только для Дениса.',w:['denis']},
  {id:'daily',t:'Бить Денису жопу',d:'Каждый день около 14:00, только для Жанны.',w:['zhanna']}
];
function remBuild(){remBody.innerHTML=REM.map(function(r){
  return '<section class="rc" data-card="'+r.id+'"><div class="rh"><div><h3>'+r.t+'</h3><p class="rd">'+r.d+'</p></div></div>'+
    '<div class="rw"><span>Кому:</span>'+r.w.map(function(p){return '<label class="chk"><input type="checkbox" data-r="'+r.id+'" data-key="'+p+'" checked>'+NM[p]+'</label>'}).join('')+
    '<button class="sw" type="button" role="switch" aria-checked="true" aria-label="Включить: '+r.t+'" data-r="'+r.id+'" data-key="on"></button></div></section>'}).join('')}
function remSync(){if(!R.rem)return;
  REM.forEach(function(r){var s=R.rem.settings[r.id]||{},on=s.on!==false,card=remBody.querySelector('[data-card="'+r.id+'"]');
    card.classList.toggle('off',!on);
    card.querySelector('.sw').setAttribute('aria-checked',on);
    r.w.forEach(function(p){card.querySelector('input[data-key="'+p+'"]').checked=s[p]!==false})});
  var miss=['denis','zhanna'].filter(function(p){return !R.rem.linked[p]}).map(function(p){return NM[p]});
  remWarn.hidden=!miss.length;
  if(miss.length)remWarn.innerHTML='<p>Бот ещё не подключён: '+miss.join(', ')+'. Откройте <a href="https://t.me/PersonalHelper1Bot" target="_blank" rel="noopener">@patyapatya_bot</a> в Telegram и нажмите «Запустить».</p>';listsRender()}
export function remLoad(){api('GET','/api/reminders').then(function(r){if(r.status===401){authFail();return}if(!r.ok)throw 0;
  return r.json().then(function(j){R.rem=j;remSync()})}).catch(function(){remMsg.textContent='Не удалось загрузить настройки. Обновите страницу.'})}
function remSet(id,key,v){if(!R.rem)return;(R.rem.settings[id]=R.rem.settings[id]||{})[key]=v;remSync();remMsg.textContent='…';
  api('PUT','/api/reminders',{id:id,key:key,value:v}).then(function(r){if(r.status===401){authFail();return}if(!r.ok)throw 0;
    return r.json().then(function(j){R.rem=j;remSync();remMsg.textContent='Сохранено ✓'})
  }).catch(function(){remMsg.textContent='Не удалось сохранить';remLoad()})}

export function initReminders(){
  R.sync=remSync;R.load=remLoad;
  remBody.addEventListener('click',function(e){var b=e.target.closest('.sw');if(!b)return;remSet(b.dataset.r,'on',b.getAttribute('aria-checked')!=='true')});
  remBody.addEventListener('change',function(e){var t=e.target;if(t.type!=='checkbox')return;remSet(t.dataset.r,t.dataset.key,t.checked)});
  remBuild();
  initLists();
}
