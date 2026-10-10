/* «Напоминания»: временные (/api/custom) и повторяющиеся (/api/recurring) — форма «календарь → частота → время → текст» и списки.
   Те же списки и форма есть у общих напоминаний пары (третья колонка «Общие», ответ сервера: rem.shared; запросы с shared:true, галочка у каждого из двоих).
   Открыта может быть только одна форма: R.fm.kind — 'tmp' или 'rec', R.fm.sh — общее ли. */
import {$,esc,cap,nrm,IC} from '../util.js';
import {MN,clock,mskMins,ymd,addDays,shiftM,dLabel} from '../time.js';
import {api,authFail} from '../api.js';
import {R} from './state.js';

var remMsg=$('remMsg'),tmpList=$('tmpList'),tmpForm=$('tmpForm'),tmpAdd=$('tmpAdd'),recList=$('recList'),recForm=$('recForm'),recAdd=$('recAdd');
var shrCol=$('shrCol'),shrWith=$('shrWith'),rcols=$('rcols'),shrTmpList=$('shrTmpList'),shrTmpForm=$('shrTmpForm'),shrTmpAdd=$('shrTmpAdd'),shrRecList=$('shrRecList'),shrRecForm=$('shrRecForm'),shrRecAdd=$('shrRecAdd');
var FORMS=[tmpForm,recForm,shrTmpForm,shrRecForm],ADDS=[tmpAdd,recAdd,shrTmpAdd,shrRecAdd];
var NOPAIR='Аккаунты больше не соединены: общих напоминаний нет.';
var WDV=['в воскресенье','в понедельник','во вторник','в среду','в четверг','в пятницу','в субботу'];
/* слоты «после HH:MM»: сетка с шагом 30 минут, h07…h23 и h07m30…h23m30; старые 'day' и 'evening' равны h14 и h18 (сервер их не переписывает) */
var LASTH=23,HRS=[];for(var hi=7;hi<=LASTH;hi++)HRS.push(hi);
function p2(n){return(n<10?'0':'')+n}
function slotNorm(s){return s==='day'?'h14':s==='evening'?'h18':s}
function slotHour(s){return parseInt(String(slotNorm(s)).slice(1),10)||0}
function slotMinute(s){return /m30$/.test(String(slotNorm(s)))?30:0}
function slotMins(s){return slotHour(s)*60+slotMinute(s)}
function slotKey(h,mn){return 'h'+p2(h)+(mn==='30'?'m30':'')}
function slotLbl(s){return 'после '+p2(slotHour(s))+':'+p2(slotMinute(s))}
var EV={week:'каждую неделю','2weeks':'каждые 2 недели',month:'каждый месяц'},EVK=['week','2weeks','month'];
var CHEV={'-1':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>','1':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>'};
function K(kind,sh){if(sh)return kind==='rec'?{form:shrRecForm,list:shrRecList,add:shrRecAdd,url:'/api/recurring'}:{form:shrTmpForm,list:shrTmpList,add:shrTmpAdd,url:'/api/custom'};
  return kind==='rec'?{form:recForm,list:recList,add:recAdd,url:'/api/recurring'}:{form:tmpForm,list:tmpList,add:tmpAdd,url:'/api/custom'}}
/* sh — общие напоминания пары (rem.shared), иначе личные (rem) */
function src(kind,sh){var o=sh?R.rem&&R.rem.shared:R.rem;return(o&&(kind==='rec'?o.recurring:o.custom))||[]}
function pname(){var s=R.rem&&R.rem.shared;return nrm(s&&s.name)||'Helper User'}
function slotPassed(date,slot){var c=clock();return date<c.day||(date===c.day&&mskMins()>=slotMins(slot))}
function slotOff(date,slot){return slotPassed(date,slot)&&!(R.fm&&R.fm.id&&date===R.fm.od&&slotNorm(slot)===slotNorm(R.fm.os))}
function tmpFind(id,sh){return src('tmp',sh).filter(function(x){return x.id===id})[0]}
function recFind(id,sh){return src('rec',sh).filter(function(x){return x.id===id})[0]}
function tmpPast(it){return it.sent||it.psent||it.date<clock().day}

/* форма: календарь -> (частота) -> время -> текст */
function calHtml(){
  var c=clock(),vm=R.fm.vm,a=vm.split('-'),y=+a[0],m=+a[1],first=(new Date(Date.UTC(y,m-1,1)).getUTCDay()+6)%7,
      n=new Date(Date.UTC(y,m,0)).getUTCDate(),max=addDays(c.day,365),h='';
  ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].forEach(function(w){h+='<span class="wd" aria-hidden="true">'+w+'</span>'});
  for(var i=0;i<first;i++)h+='<span></span>';
  for(var d=1;d<=n;d++){var s=ymd(y,m,d),off=s<c.day||s>max||(s===c.day&&mskMins()>=LASTH*60+30);
    h+='<button type="button" data-d="'+s+'"'+(off?' disabled':'')+(s===c.day?' class="today"':'')+' aria-pressed="'+(R.fm.date===s)+'" aria-label="'+dLabel(s)+'">'+d+'</button>'}
  return '<div class="cal-h"><button class="icon-btn" type="button" data-nav="-1" aria-label="Предыдущий месяц"'+(vm<=c.cur?' disabled':'')+'>'+CHEV['-1']+'</button>'+
    '<b>'+MN[m-1]+' '+y+'</b>'+
    '<button class="icon-btn" type="button" data-nav="1" aria-label="Следующий месяц"'+(vm>=max.slice(0,7)?' disabled':'')+'>'+CHEV['1']+'</button></div>'+
    '<div class="cal">'+h+'</div>'}
function evHint(){var a=R.fm.date.split('-'),d=+a[2],w=WDV[new Date(Date.UTC(+a[0],+a[1]-1,d)).getUTCDay()];
  return 'Первое напоминание — '+dLabel(R.fm.date)+', дальше '+EV[R.fm.every]+(R.fm.every==='month'?', '+d+'-го числа'+(d>28?' (если такого числа в месяце нет, то в последний день месяца)':''):' '+w)+'.'}
export function fmRender(focus){
  var k=R.fm?K(R.fm.kind,R.fm.sh):null,rec=!!R.fm&&R.fm.kind==='rec';
  FORMS.forEach(function(f){if(!k||f!==k.form){f.hidden=true;f.innerHTML=''}});
  ADDS.forEach(function(a){a.hidden=!!k&&a===k.add});
  if(!R.fm)return;
  k.form.hidden=false;
  var n=1,h=(R.fm.id||R.fm.sh?'<h4 class="et">'+(R.fm.id?'Изменение '+(R.fm.sh?'общего напоминания':'напоминания'):'Новое общее напоминание')+'</h4>':'')+'<h4>'+(n++)+'. Дата'+(R.fm.date?': '+dLabel(R.fm.date):'')+'</h4>'+calHtml(),ready=false;
  if(rec&&R.fm.date){
    h+='<h4>'+(n++)+'. Как часто повторять</h4><div class="slots" role="group" aria-label="Частота повторения">'+EVK.map(function(e){
      return '<button class="chip'+(R.fm.every===e?' on':'')+'" type="button" data-e="'+e+'" aria-pressed="'+(R.fm.every===e)+'">'+cap(EV[e])+'</button>'}).join('')+'</div>'+
      (R.fm.every?'<p class="rd">'+evHint()+'</p>':'')}
  if(R.fm.date&&(!rec||R.fm.every)){
    var free=0,mn=R.fm.mn||'00',sh=R.fm.slot?slotHour(R.fm.slot):-1;
    h+='<h4>'+(n++)+'. Время</h4><div class="tpick" role="group" aria-label="Время отправки"><div class="tcol" data-hc="1" role="group" aria-label="Час">'+HRS.map(function(x){
      var off=slotOff(R.fm.date,slotKey(x,'00'))&&slotOff(R.fm.date,slotKey(x,'30')),on=sh===x;if(!off)free++;
      return '<button class="chip'+(on?' on':'')+'" type="button" data-h="'+x+'"'+(off?' disabled':'')+' aria-pressed="'+on+'">'+p2(x)+'</button>'}).join('')+'</div><span class="tsep" aria-hidden="true">:</span>'+
      '<div class="tcol tmin" role="group" aria-label="Минуты">'+['00','30'].map(function(m){
      var off=sh>=0&&slotOff(R.fm.date,slotKey(sh,m)),on=mn===m;
      return '<button class="chip'+(on?' on':'')+'" type="button" data-m="'+m+'"'+(off?' disabled':'')+' aria-pressed="'+on+'">'+m+'</button>'}).join('')+'</div></div>'+
      '<p class="rd">'+(free?'Сообщение приходит в Telegram в течение примерно 10 минут после выбранного времени.':'На сегодня все времена уже прошли. Выберите другую дату.')+'</p>'}
  if(R.fm.date&&R.fm.slot&&(!rec||R.fm.every)){ready=true;
    h+='<h4>'+(n++)+'. Текст</h4><label class="sr" for="tText">Текст напоминания</label>'+
      '<textarea class="tta" id="tText" maxlength="300" rows="3" placeholder="Текст напоминания">'+esc(R.fm.text)+'</textarea>'+
      (R.fm.sh&&!R.fm.id?'<p class="rd">Придёт вам и «'+esc(pname())+'» в Telegram. Обе галочки включены, их можно поменять в списке.</p>':'')+
      '<p class="err" id="fmErr" role="alert"></p>'}
  h+='<div class="acts">'+(ready?'<button class="done" type="button" data-f="save">'+(R.fm.id?'Сохранить':'Добавить')+'</button>':'')+'<button class="btn" type="button" data-f="cancel">Отмена</button></div>';
  var oc=k.form.querySelector('[data-hc]'),st=oc?oc.scrollTop:-1;
  k.form.innerHTML=h;
  var nc=k.form.querySelector('[data-hc]');
  if(nc){var tb=nc.querySelector('.chip.on')||nc.querySelector('.chip:not(:disabled)');nc.scrollTop=st>=0?st:(tb?Math.max(0,tb.offsetTop-6):0)}
  if(focus){var f=k.form.querySelector(focus);if(f&&!f.disabled)f.focus()}}
function openForm(kind,sh){var c=clock();R.fm={kind:kind,sh:!!sh,vm:c.cur,date:'',slot:'',every:'',text:''};fmRender('[data-d="'+c.day+'"]');listsRender()}
function formClick(e){var b=e.target.closest('button');if(!b||!R.fm||b.disabled)return;
  if(b.dataset.d){R.fm.date=b.dataset.d;if(R.fm.slot&&slotOff(R.fm.date,R.fm.slot))R.fm.slot='';fmRender('[data-d="'+R.fm.date+'"]')}
  else if(b.dataset.nav){R.fm.vm=shiftM(R.fm.vm,+b.dataset.nav);fmRender('[data-nav="'+b.dataset.nav+'"]')}
  else if(b.dataset.e){R.fm.every=b.dataset.e;fmRender('[data-e="'+R.fm.every+'"]')}
  else if(b.dataset.h){var hh=+b.dataset.h,mm=R.fm.mn||'00';if(slotOff(R.fm.date,slotKey(hh,mm)))mm=mm==='00'?'30':'00';R.fm.mn=mm;R.fm.slot=slotKey(hh,mm);fmRender('[data-h="'+hh+'"]')}
  else if(b.dataset.m){R.fm.mn=b.dataset.m;if(R.fm.slot)R.fm.slot=slotKey(slotHour(R.fm.slot),R.fm.mn);fmRender('[data-m="'+R.fm.mn+'"]')}
  else if(b.dataset.f==='cancel'){var eid=R.fm.id,k=K(R.fm.kind,R.fm.sh),en;R.fm=null;fmRender();listsRender();en=eid&&k.list.querySelector('[data-edit="'+eid+'"]');(en||k.add).focus()}
  else if(b.dataset.f==='save')fmSave()}
function formInput(e){if(R.fm&&e.target.id==='tText')R.fm.text=e.target.value}
function fmDone(j,id,kind,sh){var k=K(kind,sh);R.rem=j;R.fm=null;fmRender();R.sync();remMsg.textContent='Сохранено ✓';var n=id&&k.list.querySelector('[data-edit="'+id+'"]');(n||k.add).focus()}
function fmSave(){
  var kind=R.fm.kind,sh=!!R.fm.sh,k=K(kind,sh),rec=kind==='rec',err=$('fmErr'),btn=k.form.querySelector('[data-f="save"]'),text=R.fm.text.trim(),id=R.fm.id,m='POST',body;
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
  if(sh)body.shared=true;
  err.textContent='';btn.disabled=true;
  api(m,k.url,body).then(function(r){
    if(r.status===401){authFail();return}
    return r.json().catch(function(){return{}}).then(function(j){
      if(!r.ok){
        if(j.error==='nopair'){R.fm=null;fmRender();remMsg.textContent=NOPAIR;R.load();return}
        if(j.error==='gone'||j.error==='past'){R.fm=null;fmRender();remMsg.textContent=j.error==='gone'?'Это напоминание уже удалено.':'Это напоминание уже отправлено, изменить нельзя.';R.load();return}
        btn.disabled=false;err.textContent=({late:'Это время уже прошло. Выберите другое.',limit:'Слишком много напоминаний. Удалите ненужные.','bad date':'Эту дату выбрать нельзя.'})[j.error]||'Не удалось сохранить.';return}
      fmDone(j,id,kind,sh)})
  }).catch(function(){btn.disabled=false;err.textContent='Не удалось сохранить. Проверьте соединение.'})}
function tmpEdit(id,sh){var it=tmpFind(id,sh),c=clock();
  if(!it||it.sent||it.psent)return;
  R.fm={kind:'tmp',sh:!!sh,id:id,vm:it.date<c.day?c.cur:it.date.slice(0,7),date:it.date,slot:it.slot,mn:slotMinute(it.slot)?'30':'00',od:it.date,os:it.slot,ot:it.text,text:it.text};
  listsRender();fmRender(it.date<c.day?'#tText':'[data-d="'+it.date+'"]');K('tmp',sh).form.scrollIntoView({block:'nearest'})}
// правка повторяющегося: показана ближайшая дата, частота, время и текст
function recEdit(id,sh){var it=recFind(id,sh),c=clock();
  if(!it)return;
  var d=it.next&&it.next>=c.day?it.next:c.day;
  R.fm={kind:'rec',sh:!!sh,id:id,vm:d.slice(0,7),date:d,slot:it.slot,mn:slotMinute(it.slot)?'30':'00',every:it.every,od:d,os:it.slot,oe:it.every,ot:it.text,text:it.text};
  listsRender();fmRender('[data-d="'+d+'"]');K('rec',sh).form.scrollIntoView({block:'nearest'})}

/* списки */
/* строка с переключателем: у личного одна («Включено»), у общего две — своя и партнёра (менять может любой из двоих) */
function swRows(it,sh,off){
  if(!sh)return '<div class="rw"><span>Включено</span>'+
    '<button class="sw" type="button" role="switch" aria-checked="'+(it.on?'true':'false')+'" aria-label="Включить напоминание" data-t="'+esc(it.id)+'" data-key="on"'+(off?' disabled':'')+'></button></div>';
  function row(who,label,on,aria){return '<div class="rw rwp"><span>'+esc(label)+'</span>'+
    '<button class="sw" type="button" role="switch" aria-checked="'+(on?'true':'false')+'" aria-label="'+esc(aria)+'" data-t="'+esc(it.id)+'" data-key="on" data-who="'+who+'"'+(off?' disabled':'')+'></button></div>'}
  return row('me','Вы',it.on,'Включить напоминание для вас')+row('partner',pname(),it.pon,'Включить напоминание для '+pname())}
function shSent(it){return it.sent&&it.psent?' · Отправлено обоим ✓':it.sent?' · Отправлено вам ✓':it.psent?' · Отправлено: '+esc(pname())+' ✓':''}
function delBtns(it,sh,armed,edit){
  return '<div class="ra">'+(edit&&!armed?'<button class="x ed" type="button" data-edit="'+esc(it.id)+'" aria-label="Изменить напоминание">'+IC.pen+'</button>':'')+
    (armed?'<button class="del arm" type="button" data-del="'+esc(it.id)+'">Уверены?</button>'
          :'<button class="x del" type="button" data-del="'+esc(it.id)+'" aria-label="'+(sh?'Удалить общее напоминание (у обоих)':'Удалить напоминание')+'">'+IC.x+'</button>')+'</div>'}
function tmpItemHtml(it,sh){
  var all=sh?!!(it.sent||it.psent):it.sent===true,missed=!all&&it.date<clock().day,past=all||missed,on=sh?(it.on||it.pon):it.on,
      status=all?(sh?shSent(it):' · Отправлено ✓'):missed?' · Не отправлено':(on?'':' · Выключено'),armed=R.delArm===it.id;
  return '<section class="rc tmp'+(sh?' shr':'')+(past?' past':'')+(on?'':' off')+(R.fm&&R.fm.id===it.id?' editing':'')+'" data-t="'+esc(it.id)+'">'+
    '<div class="rh"><div><p class="tt">'+esc(it.text)+'</p><p class="rd">'+dLabel(it.date)+', '+slotLbl(it.slot)+status+'</p></div>'+delBtns(it,sh,armed,!all)+'</div>'+
    swRows(it,sh,past)+'</section>'}
function recItemHtml(it,sh){
  var armed=R.delArm===it.id,on=sh?(it.on||it.pon):it.on;
  return '<section class="rc tmp rec'+(sh?' shr':'')+(on?'':' off')+(R.fm&&R.fm.id===it.id?' editing':'')+'" data-t="'+esc(it.id)+'">'+
    '<div class="rh"><div><p class="tt">'+esc(it.text)+'</p><p class="rd">'+cap(EV[it.every]||'')+', '+slotLbl(it.slot)+(on?'':' · Выключено')+'</p>'+
    (it.next?'<p class="rd">Ближайшее: '+dLabel(it.next)+'</p>':'')+'</div>'+delBtns(it,sh,armed,true)+'</div>'+
    swRows(it,sh,false)+'</section>'}
function listRender(kind,sh){
  if(!R.rem)return;
  var k=K(kind,sh),rec=kind==='rec',sel='',ae=document.activeElement,items=src(kind,sh).filter(function(x){return x&&typeof x.id==='string'}),
      one=function(it){return rec?recItemHtml(it,sh):tmpItemHtml(it,sh)};
  if(ae&&k.list.contains(ae)&&ae.dataset){if(ae.dataset.edit)sel='[data-edit="'+ae.dataset.edit+'"]';else if(ae.dataset.del)sel='[data-del="'+ae.dataset.del+'"]';else if(ae.dataset.t&&ae.dataset.key)sel='[data-t="'+ae.dataset.t+'"][data-key="'+ae.dataset.key+'"]'+(ae.dataset.who?'[data-who="'+ae.dataset.who+'"]':'')}
  if(rec)k.list.innerHTML=items.length?items.map(one).join(''):'<p class="empty">'+(sh?'Общих повторяющихся':'Повторяющихся')+' напоминаний пока нет.</p>';
  else{var up=items.filter(function(i){return!tmpPast(i)}),pa=items.filter(tmpPast).reverse();
    k.list.innerHTML=items.length?up.concat(pa).map(one).join(''):'<p class="empty">'+(sh?'Общих временных':'Временных')+' напоминаний пока нет.</p>'}
  if(sel){var n=k.list.querySelector(sel);if(n)n.focus()}}
/* третья колонка «Общие» есть, только пока аккаунты соединены (в ответе есть shared); пропала связь — открытая общая форма закрывается */
export function listsRender(){
  var s=R.rem&&R.rem.shared&&R.rem.shared.linked?R.rem.shared:null;
  if(R.fm&&R.fm.sh&&!s){R.fm=null;fmRender()}
  shrCol.hidden=!s;rcols.classList.toggle('r3',!!s);
  if(s)shrWith.textContent='Вместе с «'+pname()+'»';
  listRender('tmp');listRender('rec');
  if(s){listRender('tmp',true);listRender('rec',true)}}
function tmpSave(req){remMsg.textContent='…';
  req.then(function(r){if(r.status===401){authFail();return}
    return r.json().catch(function(){return{}}).then(function(j){
      if(!r.ok){if(j.error==='nopair'){remMsg.textContent=NOPAIR;R.load();return}throw 0}
      R.rem=j;R.sync();remMsg.textContent='Сохранено ✓'})
  }).catch(function(){remMsg.textContent='Не удалось сохранить';R.load()})}
function lFind(kind,id,sh){return kind==='rec'?recFind(id,sh):tmpFind(id,sh)}
/* who у общего: 'me' — своя галочка, 'partner' — галочка партнёра */
function lSet(kind,id,key,v,sh,who){var it=lFind(kind,id,sh),body={id:id,key:key,value:v};if(!it)return;
  if(key==='on'){if(sh&&who==='partner')it.pon=v;else it.on=v}
  if(sh){body.shared=true;body.who=who==='partner'?'partner':'me'}
  listRender(kind,sh);tmpSave(api('PUT',K(kind,sh).url,body))}
function lDelete(kind,id,sh){var o=sh?R.rem&&R.rem.shared:R.rem;if(!o)return;var keep=function(x){return x.id!==id};
  if(kind==='rec')o.recurring=(o.recurring||[]).filter(keep);else o.custom=(o.custom||[]).filter(keep);
  listRender(kind,sh);tmpSave(api('DELETE',K(kind,sh).url+'?id='+encodeURIComponent(id)+(sh?'&shared=1':'')))}
function bindList(kind,sh){var list=K(kind,sh).list;
  list.addEventListener('click',function(e){var b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.dataset.edit){if(kind==='rec')recEdit(b.dataset.edit,sh);else tmpEdit(b.dataset.edit,sh);return}
    if(b.dataset.del){var id=b.dataset.del;
      if(R.delArm!==id){R.delArm=id;clearTimeout(R.delTimer);R.delTimer=setTimeout(function(){R.delArm='';listsRender()},4000);listRender(kind,sh);return}
      clearTimeout(R.delTimer);R.delArm='';lDelete(kind,id,sh);return}
    if(b.dataset.key==='on')lSet(kind,b.dataset.t,'on',b.getAttribute('aria-checked')!=='true',sh,b.dataset.who)});}

export function initLists(){
  tmpAdd.addEventListener('click',function(){openForm('tmp')});
  recAdd.addEventListener('click',function(){openForm('rec')});
  shrTmpAdd.addEventListener('click',function(){openForm('tmp',true)});
  shrRecAdd.addEventListener('click',function(){openForm('rec',true)});
  FORMS.forEach(function(f){f.addEventListener('click',formClick);f.addEventListener('input',formInput)});
  bindList('tmp');bindList('rec');bindList('tmp',true);bindList('rec',true);
}
