/* Кэшбэк: сборка разметки (блоки, компактный вид, история, свои категории) и отрисовка */
import {$,esc,fp,cls,opts,IC,ls} from '../util.js';
import {label} from '../time.js';
import {accName} from '../account.js';
import {BANKS,PCTS,C,peek,ppeek,list,blank,allCats,hasAny} from './state.js';

var stage=$('stage'),months=$('months'),pNext=$('pNext'),prompt_=$('prompt');

function bn(id){return BANKS[id]?BANKS[id].n:String(id||'')}
function badge(id){var b=BANKS[id];if(!b)return '';
  return '<span class="badge" aria-hidden="true"'+(b.f?' style="--f:'+b.f+'"':'')+'><img src="logos/'+id+'.svg" alt=""><b>'+b.m+'</b></span>'}

function colHtml(mo,ro,lst){
  var l=lst||peek(mo),h='<div class="col">';
  if(!C.edit||ro){
    var shown=l.filter(function(b){return b.items.length});
    if(!shown.length){
      if(ro)return h+'<p class="empty">Пусто</p></div>';
      var cp=mo===C.ck.nxt&&hasAny(C.ck.cur)?'<button class="copybtn" data-m="copy" type="button">Скопировать из текущего месяца</button>':'';
      return h+'<div class="emptybox"><button class="addbtn" data-act="add" type="button">+ Добавить</button>'+cp+'</div></div>'}
    return h+shown.map(function(b){return '<section class="blk"><div class="head">'+badge(b.bank)+'<h4>'+esc(bn(b.bank))+'</h4></div><div class="body">'+
      b.items.map(function(i){
        return '<div class="row"><span>'+esc(i.cat)+'</span><span class="pct">'+fp(i.pct)+'%</span></div>'}).join('')+'</div></section>'}).join('')+'</div>';
  }
  var used=l.map(function(b){return b.bank}),ids=Object.keys(BANKS).map(function(k){return{id:k,t:BANKS[k].n}});
  return h+l.map(function(b,i){var d=' data-mo="'+mo+'" data-b="'+i+'"',last=i===l.length-1;
    return '<section class="blk"><div class="head">'+badge(b.bank)+'<select data-k="bank"'+d+cls(b.bank)+' aria-label="Банк">'+opts(ids,b.bank,'Банк',used)+'</select>'+
      '<button class="x" data-act="delb"'+d+' aria-label="Удалить банк" type="button">'+IC.x+'</button></div><div class="body">'+
      b.items.map(function(r,j){var e=d+' data-r="'+j+'"';return '<div class="r"><select data-k="cat"'+e+cls(r.cat)+' aria-label="Категория">'+opts(allCats(),r.cat,'Категория')+'<option value="__new">＋ Своя категория…</option></select>'+
        '<select data-k="pct"'+e+cls(r.pct)+' aria-label="Процент">'+opts(PCTS.map(function(x){return{id:x,t:fp(x)+' %'}}),r.pct,'%')+'</select>'+
        '<button class="x" data-act="delr"'+e+' aria-label="Удалить кэшбэк" type="button">'+IC.x+'</button></div>'}).join('')+
      '<div class="acts"><button class="btn" data-act="addr"'+d+' type="button">+ Кэшбэк</button>'+
      (last?'<button class="btn" data-act="addb" data-mo="'+mo+'" type="button"'+(l.length>=Object.keys(BANKS).length?' disabled':'')+'>+ Банк</button>':'')+'</div></div></section>'}).join('')+'</div>';
}
/* ---------- значки банков и сравнение двух людей ---------- */
function mini(id){var b=BANKS[id];if(!b)return '';
  return '<span class="mb" title="'+esc(b.n)+'"'+(b.f?' style="--f:'+b.f+'"':'')+'><img src="logos/'+esc(id)+'.svg" alt="'+esc(b.n)+'"><b>'+esc(b.m)+'</b></span>'}
/* «Сравнение» (соединённые аккаунты, третья колонка): по каждой категории лучший процент у каждого и банки с ним; у кого процент выше — best, у другого dim,
   при равенстве у обоих best, запись только у одного — без подсветки. Подсветка в кэшбэке есть только здесь. Первая колонка своя (подпись accName()), вторая партнёра */
function topOf(l){var g={};
  l.forEach(function(b){b.items.forEach(function(i){if(!i.cat||!i.pct)return;var v=parseFloat(i.pct),e=g[i.cat];
    if(!e||v>e.v)g[i.cat]={v:v,banks:[b.bank]};else if(v===e.v)e.banks.push(b.bank)})});
  return g}
function vcell(e,cl){return '<div class="vc'+cl+'" role="cell">'+(e?'<span class="pct">'+fp(e.v)+'%</span><span class="cw">'+e.banks.map(mini).join('')+'</span>':'<span class="vn">—</span>')+'</div>'}
function vsHtml(mo){var a=topOf(peek(mo)),b=topOf(ppeek(mo));
  var cats=Object.keys(a).concat(Object.keys(b).filter(function(c){return !a[c]})).sort(function(x,y){return x.localeCompare(y,'ru')});
  if(!cats.length)return '';
  return '<div class="vs" role="table"><div class="vh" role="row"><div role="columnheader">Категория</div><div role="columnheader">'+esc(accName())+'</div><div role="columnheader">'+esc(C.partner.name)+'</div></div>'+
    cats.map(function(c){var x=a[c],y=b[c],cx='',cy='';
      if(x&&y){cx=x.v>=y.v?' best':' dim';cy=y.v>=x.v?' best':' dim'}
      return '<div class="vr" role="row"><div class="vk" role="rowheader">'+esc(c)+'</div>'+vcell(x,cx)+vcell(y,cy)+'</div>'}).join('')+'</div>'}
/* колонка человека: блоки банков за месяц; l — список банков месяца этого человека */
function side(mo,ro,l){return '<div class="cols">'+colHtml(mo,ro,l)+'</div>'}
/* соединённые аккаунты: слева свой кэшбэк (имя из настроек), справа партнёра, только на просмотр, третья колонка — «Сравнение» (если у кого-то есть категории);
   в режиме правки партнёр скрыт, правка идёт на всю ширину */
function colsHtml(mo,ro){
  if(C.partner&&(!C.edit||ro)){var vs=vsHtml(mo);
    return '<div class="pairw"><div class="pair'+(vs?' p3':'')+'"><div class="pc"><h3 class="pn">'+esc(accName())+'</h3>'+side(mo,ro,peek(mo))+'</div>'+
      '<div class="pc"><h3 class="pn">'+esc(C.partner.name)+'</h3>'+side(mo,true,ppeek(mo))+'</div>'+
      (vs?'<div class="pc pcv"><h3 class="pn">Сравнение</h3>'+vs+'</div>':'')+'</div></div>'}
  return side(mo,ro,peek(mo))}
function histMonths(){var ms={};
  function add(d){Object.keys(d).forEach(function(mo){if(mo<C.ck.cur&&d[mo].some(function(b){return b.items.length}))ms[mo]=1})}
  add(C.data.months);if(C.partner)add(C.partner.months);
  return Object.keys(ms).sort().reverse()}
function histHtml(){var ms=histMonths();if(!ms.length)return '<p class="empty">История пока пуста: здесь появятся прошлые месяцы.</p>';
  if(ms.indexOf(C.histMo)<0)C.histMo=ms[0];
  return '<div class="chips">'+ms.map(function(m){return '<button class="chip'+(m===C.histMo?' on':'')+'" data-h="pick" data-mo="'+m+'" type="button">'+label(m)+'</button>'}).join('')+'</div>'+colsHtml(C.histMo,true)}
function customHtml(){if(!C.data.custom.length)return '';
  return '<div class="cust"><h2>Свои категории</h2>'+C.data.custom.map(function(c,i){
    return '<div class="crow"><span>'+esc(c)+'</span><button class="x" data-act="rc" data-b="'+i+'" aria-label="Переименовать" type="button">'+IC.pen+'</button><button class="x" data-act="dc" data-b="'+i+'" aria-label="Удалить" type="button">'+IC.x+'</button></div>'}).join('')+'</div>'}

function view(){
  var open=ls('nm-open')===C.ck.cur,snooze=ls('nm-snooze')===C.ck.day;
  C.showNext=C.ck.late&&open;
  var showPrompt=C.ck.late&&!open&&!snooze;
  stage.classList.toggle('two',C.showNext);months.classList.toggle('open',C.showNext);prompt_.classList.toggle('open',showPrompt);
  pNext.inert=!C.showNext;prompt_.inert=!showPrompt}
function ensureBlank(){[C.ck.cur].concat(C.showNext?[C.ck.nxt]:[]).forEach(function(mo){var l=list(mo);if(!l.length)l.push(blank())})}

export function render(){
  view();if(C.edit)ensureBlank();stage.classList.toggle('pr',!!C.partner&&!C.edit);
  var a=document.activeElement,d=a&&a.dataset,key=d&&(d.k||d.act||d.h)?{k:d.k,act:d.act,h:d.h,mo:d.mo,b:d.b,r:d.r}:null,y=window.scrollY;
  $('tCur').textContent=label(C.ck.cur);$('tNext').textContent=label(C.ck.nxt);
  $('bCur').innerHTML=colsHtml(C.ck.cur);$('bNext').innerHTML=colsHtml(C.ck.nxt);
  $('foot').innerHTML=C.edit?customHtml()+'<div class="editbar"><button class="done" data-act="save" type="button">Сохранить изменения</button><button class="done danger" data-act="discard" type="button">Выйти без сохранения</button></div>':'';
  var hh=histHtml();if(hh!==C.hCache){$('hBody').innerHTML=hh;C.hCache=hh}
  $('hist').classList.toggle('open',C.histOpen);$('hist').inert=!C.histOpen;$('hBtn').setAttribute('aria-expanded',C.histOpen);
  window.scrollTo(0,y);
  if(key){var q='['+(key.k?'data-k="'+key.k+'"':key.act?'data-act="'+key.act+'"':'data-h="'+key.h+'"')+']'+(key.mo!==undefined?'[data-mo="'+key.mo+'"]':'')+(key.b!==undefined?'[data-b="'+key.b+'"]':'')+(key.r!==undefined?'[data-r="'+key.r+'"]':'');
    var n=stage.querySelector(q);if(n)n.focus({preventScroll:true})}
}
