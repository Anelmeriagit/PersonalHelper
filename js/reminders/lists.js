/* «Напоминания»: временные (/api/custom) и повторяющиеся (/api/recurring) — форма «календарь → частота → время → текст» и списки.
   Открыта может быть только одна форма: R.fm.kind — 'tmp' или 'rec'. */
import {$,esc,cap,IC} from '../util.js';
import {MN,clock,mskHour,ymd,addDays,shiftM,dLabel} from '../time.js';
import {api,authFail} from '../api.js';
import {R} from './state.js';

var remMsg=$('remMsg'),tmpList=$('tmpList'),tmpForm=$('tmpForm'),tmpAdd=$('tmpAdd'),recList=$('recList'),recForm=$('recForm'),recAdd=$('recAdd');
var WDV=['в воскресенье','в понедельник','во вторник','в среду','в четверг','в пятницу','в субботу'];
var SL={day:'после 14:00',evening:'после 18:00'},SLH={day:14,evening:18};
var EV={week:'каждую неделю','2weeks':'каждые 2 недели',month:'каждый месяц'},EVK=['week','2weeks','month'];
var CHEV={'-1':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>','1':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>'};
function K(kind){return kind==='rec'?{form:recForm,list:recList,add:recAdd,url:'/api/recurring'}:{form:tmpForm,list:tmpList,add:tmpAdd,url:'/api/custom'}}
function slotPassed(date,slot){var c=clock();return date<c.day||(date===c.day&&mskHour()>=SLH[slot])}
function slotOff(date,slot){return slotPassed(date,slot)&&!(R.fm&&R.fm.id&&date===R.fm.od&&slot===R.fm.os)}
function tmpFind(id){return(R.rem&&R.rem.custom||[]).filter(function(x){return x.id===id})[0]}
function recFind(id){return(R.rem&&R.rem.recurring||[]).filter(function(x){return x.id===id})[0]}
function tmpPast(it){return it.sent||it.date<clock().day}

/* форма: календарь -> (частота) -> время -> текст */
function calHtml(){
  var c=clock(),vm=R.fm.vm,a=vm.split('-'),y=+a[0],m=+a[1],first=(new Date(Date.UTC(y,m-1,1)).getUTCDay()+6)%7,
      n=new Date(Date.UTC(y,m,0)).getUTCDate(),max=addDays(c.day,365),h='';
  ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].forEach(function(w){h+='<span class="wd" aria-hidden="true">'+w+'</span>'});
  for(var i=0;i<first;i++)h+='<span></span>';
  for(var d=1;d<=n;d++){var s=ymd(y,m,d),off=s<c.day||s>max||(s===c.day&&mskHour()>=SLH.evening);
    h+='<button type="button" data-d="'+s+'"'+(off?' disabled':'')+(s===c.day?' class="today"':'')+' aria-pressed="'+(R.fm.date===s)+'" aria-label="'+dLabel(s)+'">'+d+'</button>'}
  return '<div class="cal-h"><button class="icon-btn" type="button" data-nav="-1" aria-label="Предыдущий месяц"'+(vm<=c.cur?' disabled':'')+'>'+CHEV['-1']+'</button>'+
    '<b>'+MN[m-1]+' '+y+'</b>'+
    '<button class="icon-btn" type="button" data-nav="1" aria-label="Следующий месяц"'+(vm>=max.slice(0,7)?' disabled':'')+'>'+CHEV['1']+'</button></div>'+
    '<div class="cal">'+h+'</div>'}
function evHint(){var a=R.fm.date.split('-'),d=+a[2],w=WDV[new Date(Date.UTC(+a[0],+a[1]-1,d)).getUTCDay()];
  return 'Первое напоминание — '+dLabel(R.fm.date)+', дальше '+EV[R.fm.every]+(R.fm.every==='month'?', '+d+'-го числа'+(d>28?' (если такого числа в месяце нет, то в последний день месяца)':''):' '+w)+'.'}
export function fmRender(focus){
  var k=R.fm?K(R.fm.kind):null,rec=!!R.fm&&R.fm.kind==='rec';
  [tmpForm,recForm].forEach(function(f){if(!k||f!==k.form){f.hidden=true;f.innerHTML=''}});
  [tmpAdd,recAdd].forEach(function(a){a.hidden=!!k&&a===k.add});
  if(!R.fm)return;
  k.form.hidden=false;
  var n=1,h=(R.fm.id?'<h4 class="et">Изменение напоминания</h4>':'')+'<h4>'+(n++)+'. Дата'+(R.fm.date?': '+dLabel(R.fm.date):'')+'</h4>'+calHtml(),ready=false;
  if(rec&&R.fm.date){
    h+='<h4>'+(n++)+'. Как часто повторять</h4><div class="slots" role="group" aria-label="Частота повторения">'+EVK.map(function(e){
      return '<button class="chip'+(R.fm.every===e?' on':'')+'" type="button" data-e="'+e+'" aria-pressed="'+(R.fm.every===e)+'">'+cap(EV[e])+'</button>'}).join('')+'</div>'+
      (R.fm.every?'<p class="rd">'+evHint()+'</p>':'')}
  if(R.fm.date&&(!rec||R.fm.every)){
    var free=0;
    h+='<h4>'+(n++)+'. Время</h4><div class="slots" role="group" aria-label="Время отправки">'+['day','evening'].map(function(s){var off=slotOff(R.fm.date,s);if(!off)free++;
      return '<button class="chip'+(R.fm.slot===s?' on':'')+'" type="button" data-s="'+s+'"'+(off?' disabled':'')+' aria-pressed="'+(R.fm.slot===s)+'">'+cap(SL[s])+'</button>'}).join('')+'</div>'+
      '<p class="rd">'+(free?'Сообщение приходит в Telegram в течение часа после выбранного времени.':'На сегодня оба времени уже прошли. Выберите другую дату.')+'</p>'}
  if(R.fm.date&&R.fm.slot&&(!rec||R.fm.every)){ready=true;
    h+='<h4>'+(n++)+'. Текст</h4><label class="sr" for="tText">Текст напоминания</label>'+
      '<textarea class="tta" id="tText" maxlength="300" rows="3" placeholder="Текст напоминания">'+esc(R.fm.text)+'</textarea>'+
      '<p class="err" id="fmErr" role="alert"></p>'}
  h+='<div class="acts">'+(ready?'<button class="done" type="button" data-f="save">'+(R.fm.id?'Сохранить':'Добавить')+'</button>':'')+'<button class="btn" type="button" data-f="cancel">Отмена</button></div>';
  k.form.innerHTML=h;
  if(focus){var f=k.form.querySelector(focus);if(f&&!f.disabled)f.focus()}}
function openForm(kind){var c=clock();R.fm={kind:kind,vm:c.cur,date:'',slot:'',every:'',text:''};fmRender('[data-d="'+c.day+'"]');listsRender()}
function formClick(e){var b=e.target.closest('button');if(!b||!R.fm||b.disabled)return;
  if(b.dataset.d){R.fm.date=b.dataset.d;if(R.fm.slot&&slotOff(R.fm.date,R.fm.slot))R.fm.slot='';fmRender('[data-d="'+R.fm.date+'"]')}
  else if(b.dataset.nav){R.fm.vm=shiftM(R.fm.vm,+b.dataset.nav);fmRender('[data-nav="'+b.dataset.nav+'"]')}
  else if(b.dataset.e){R.fm.every=b.dataset.e;fmRender('[data-e="'+R.fm.every+'"]')}
  else if(b.dataset.s){R.fm.slot=b.dataset.s;fmRender('#tText')}
  else if(b.dataset.f==='cancel'){var eid=R.fm.id,k=K(R.fm.kind),en;R.fm=null;fmRender();listsRender();en=eid&&k.list.querySelector('[data-edit="'+eid+'"]');(en||k.add).focus()}
  else if(b.dataset.f==='save')fmSave()}
function formInput(e){if(R.fm&&e.target.id==='tText')R.fm.text=e.target.value}
function fmDone(j,id,kind){var k=K(kind);R.rem=j;R.fm=null;fmRender();R.sync();remMsg.textContent='Сохранено ✓';var n=id&&k.list.querySelector('[data-edit="'+id+'"]');(n||k.add).focus()}
function fmSave(){
  var kind=R.fm.kind,k=K(kind),rec=kind==='rec',err=$('fmErr'),btn=k.form.querySelector('[data-f="save"]'),text=R.fm.text.trim(),id=R.fm.id,m='POST',body;
  if(!text){err.textContent='Напишите текст напоминания.';return}
  if(id){m='PUT';body={id:id};
    var evCh=rec&&R.fm.every!==R.fm.oe;
    // смена частоты без смены даты: отсчёт идёт от показанной ближайшей даты, иначе расписание «поедет»
    if(R.fm.date!==R.fm.od||evCh)body.date=R.fm.date;
    if(R.fm.slot!==R.fm.os)body.slot=R.fm.slot;
    if(evCh)body.every=R.fm.every;
    if(text!==R.fm.ot)body.text=text;
    if(Object.keys(body).length<2){R.fm=null;fmRender();listsRender();var q=k.list.querySelector('[data-edit="'+id+'"]');if(q)q.focus();return}
  }else{
    body={date:R.fm.date,slot:R.fm.slot,text:text};
    if(rec)body.every=R.fm.every}
  err.textContent='';btn.disabled=true;
  api(m,k.url,body).then(function(r){
    if(r.status===401){authFail();return}
    return r.json().catch(function(){return{}}).then(function(j){
      if(!r.ok){
        if(j.error==='gone'||j.error==='past'){R.fm=null;fmRender();remMsg.textContent=j.error==='gone'?'Это напоминание уже удалено.':'Это напоминание уже отправлено, изменить нельзя.';R.load();return}
        btn.disabled=false;err.textContent=({late:'Это время уже прошло. Выберите другое.',limit:'Слишком много напоминаний. Удалите ненужные.','bad date':'Эту дату выбрать нельзя.'})[j.error]||'Не удалось сохранить.';return}
      fmDone(j,id,kind)})
  }).catch(function(){btn.disabled=false;err.textContent='Не удалось сохранить. Проверьте соединение.'})}
function tmpEdit(id){var it=tmpFind(id),c=clock();
  if(!it||it.sent)return;
  R.fm={kind:'tmp',id:id,vm:it.date<c.day?c.cur:it.date.slice(0,7),date:it.date,slot:it.slot,od:it.date,os:it.slot,ot:it.text,text:it.text};
  listsRender();fmRender(it.date<c.day?'#tText':'[data-d="'+it.date+'"]');tmpForm.scrollIntoView({block:'nearest'})}
// правка повторяющегося: показана ближайшая дата, частота, время и текст
function recEdit(id){var it=recFind(id),c=clock();
  if(!it)return;
  var d=it.next&&it.next>=c.day?it.next:c.day;
  R.fm={kind:'rec',id:id,vm:d.slice(0,7),date:d,slot:it.slot,every:it.every,od:d,os:it.slot,oe:it.every,ot:it.text,text:it.text};
  listsRender();fmRender('[data-d="'+d+'"]');recForm.scrollIntoView({block:'nearest'})}

/* списки */
function tmpItemHtml(it){
  var all=it.sent===true,missed=!all&&it.date<clock().day,past=all||missed,
      status=all?' · Отправлено ✓':missed?' · Не отправлено':(it.on?'':' · Выключено'),armed=R.delArm===it.id;
  return '<section class="rc tmp'+(past?' past':'')+(it.on?'':' off')+(R.fm&&R.fm.id===it.id?' editing':'')+'" data-t="'+esc(it.id)+'">'+
    '<div class="rh"><div><p class="tt">'+esc(it.text)+'</p><p class="rd">'+dLabel(it.date)+', '+SL[it.slot]+status+'</p></div><div class="ra">'+(all||armed?'':'<button class="x ed" type="button" data-edit="'+esc(it.id)+'" aria-label="Изменить напоминание">'+IC.pen+'</button>')+
    (armed?'<button class="del arm" type="button" data-del="'+esc(it.id)+'">Уверены?</button>'
          :'<button class="x del" type="button" data-del="'+esc(it.id)+'" aria-label="Удалить напоминание">'+IC.x+'</button>')+'</div></div>'+
    '<div class="rw"><span>Включено</span>'+
    '<button class="sw" type="button" role="switch" aria-checked="'+(it.on?'true':'false')+'" aria-label="Включить напоминание" data-t="'+esc(it.id)+'" data-key="on"'+(past?' disabled':'')+'></button></div></section>'}
function recItemHtml(it){
  var armed=R.delArm===it.id;
  return '<section class="rc tmp rec'+(it.on?'':' off')+(R.fm&&R.fm.id===it.id?' editing':'')+'" data-t="'+esc(it.id)+'">'+
    '<div class="rh"><div><p class="tt">'+esc(it.text)+'</p><p class="rd">'+cap(EV[it.every]||'')+', '+SL[it.slot]+(it.on?'':' · Выключено')+'</p>'+
    (it.next?'<p class="rd">Ближайшее: '+dLabel(it.next)+'</p>':'')+'</div><div class="ra">'+(armed?'':'<button class="x ed" type="button" data-edit="'+esc(it.id)+'" aria-label="Изменить напоминание">'+IC.pen+'</button>')+
    (armed?'<button class="del arm" type="button" data-del="'+esc(it.id)+'">Уверены?</button>'
          :'<button class="x del" type="button" data-del="'+esc(it.id)+'" aria-label="Удалить напоминание">'+IC.x+'</button>')+'</div></div>'+
    '<div class="rw"><span>Включено</span>'+
    '<button class="sw" type="button" role="switch" aria-checked="'+(it.on?'true':'false')+'" aria-label="Включить напоминание" data-t="'+esc(it.id)+'" data-key="on"></button></div></section>'}
function listRender(kind){
  if(!R.rem)return;
  var k=K(kind),rec=kind==='rec',sel='',ae=document.activeElement,items=((rec?R.rem.recurring:R.rem.custom)||[]).filter(function(x){return x&&typeof x.id==='string'});
  if(ae&&k.list.contains(ae)&&ae.dataset){if(ae.dataset.edit)sel='[data-edit="'+ae.dataset.edit+'"]';else if(ae.dataset.del)sel='[data-del="'+ae.dataset.del+'"]';else if(ae.dataset.t&&ae.dataset.key)sel='[data-t="'+ae.dataset.t+'"][data-key="'+ae.dataset.key+'"]'}
  if(rec)k.list.innerHTML=items.length?items.map(recItemHtml).join(''):'<p class="empty">Повторяющихся напоминаний пока нет.</p>';
  else{var up=items.filter(function(i){return!tmpPast(i)}),pa=items.filter(tmpPast).reverse();
    k.list.innerHTML=items.length?up.concat(pa).map(tmpItemHtml).join(''):'<p class="empty">Временных напоминаний пока нет.</p>'}
  if(sel){var n=k.list.querySelector(sel);if(n)n.focus()}}
export function listsRender(){listRender('tmp');listRender('rec')}
function tmpSave(req){remMsg.textContent='…';
  req.then(function(r){if(r.status===401){authFail();return}if(!r.ok)throw 0;
    return r.json().then(function(j){R.rem=j;R.sync();remMsg.textContent='Сохранено ✓'})
  }).catch(function(){remMsg.textContent='Не удалось сохранить';R.load()})}
function lFind(kind,id){return kind==='rec'?recFind(id):tmpFind(id)}
function lSet(kind,id,key,v){var it=lFind(kind,id);if(!it)return;
  if(key==='on')it.on=v;
  listRender(kind);tmpSave(api('PUT',K(kind).url,{id:id,key:key,value:v}))}
function lDelete(kind,id){if(!R.rem)return;var keep=function(x){return x.id!==id};
  if(kind==='rec')R.rem.recurring=(R.rem.recurring||[]).filter(keep);else R.rem.custom=(R.rem.custom||[]).filter(keep);
  listRender(kind);tmpSave(api('DELETE',K(kind).url+'?id='+encodeURIComponent(id)))}
function bindList(kind){var list=K(kind).list;
  list.addEventListener('click',function(e){var b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.dataset.edit){if(kind==='rec')recEdit(b.dataset.edit);else tmpEdit(b.dataset.edit);return}
    if(b.dataset.del){var id=b.dataset.del;
      if(R.delArm!==id){R.delArm=id;clearTimeout(R.delTimer);R.delTimer=setTimeout(function(){R.delArm='';listsRender()},4000);listRender(kind);return}
      clearTimeout(R.delTimer);R.delArm='';lDelete(kind,id);return}
    if(b.dataset.key==='on')lSet(kind,b.dataset.t,'on',b.getAttribute('aria-checked')!=='true')});}

export function initLists(){
  tmpAdd.addEventListener('click',function(){openForm('tmp')});
  recAdd.addEventListener('click',function(){openForm('rec')});
  [tmpForm,recForm].forEach(function(f){f.addEventListener('click',formClick);f.addEventListener('input',formInput)});
  bindList('tmp');bindList('rec');
}
