/* Кэшбэк: сборка разметки (блоки, компактный вид, история, свои категории) и отрисовка */
import {$,esc,fp,cls,opts,IC,ls} from '../util.js';
import {label} from '../time.js';
import {BANKS,PCTS,C,peek,list,blank,allCats,hasAny} from './state.js';

var stage=$('stage'),months=$('months'),pNext=$('pNext'),prompt_=$('prompt'),vsw=$('vsw');

function bn(id){return BANKS[id]?BANKS[id].n:String(id||'')}
function badge(id){var b=BANKS[id];if(!b)return '';
  return '<span class="badge" aria-hidden="true"'+(b.f?' style="--f:'+b.f+'"':'')+'><img src="logos/'+id+'.svg" alt=""><b>'+b.m+'</b></span>'}
/* подсветка в категории, где заполнено несколько банков: лучший процент — best, остальные — dim */
function hl(mo){var g={},out={};
  peek(mo).forEach(function(b){b.items.forEach(function(i){if(!i.cat||!i.pct)return;
    (g[i.cat]=g[i.cat]||[]).push({bank:b.bank,v:parseFloat(i.pct)})})});
  Object.keys(g).forEach(function(c){var e=g[c];if(e.length<2)return;
    var M=Math.max.apply(null,e.map(function(r){return r.v}));
    e.forEach(function(r){out[r.bank+'|'+c]=r.v===M?' best':' dim'})});
  return out}

function colHtml(mo,ro){
  var l=peek(mo),h='<div class="col">';
  if(!C.edit||ro){
    var hm=hl(mo),shown=l.filter(function(b){return b.items.length});
    if(!shown.length){
      if(ro)return h+'<p class="empty">Пусто</p></div>';
      var cp=mo===C.ck.nxt&&hasAny(C.ck.cur)?'<button class="copybtn" data-m="copy" type="button">Скопировать из текущего месяца</button>':'';
      return h+'<div class="emptybox"><button class="addbtn" data-act="add" type="button">+ Добавить</button>'+cp+'</div></div>'}
    return h+shown.map(function(b){return '<section class="blk"><div class="head">'+badge(b.bank)+'<h4>'+esc(bn(b.bank))+'</h4></div><div class="body">'+
      b.items.map(function(i){var c=hm[b.bank+'|'+i.cat]||'';
        return '<div class="row'+c+'"><span>'+esc(i.cat)+'</span><span class="pct">'+fp(i.pct)+'%</span></div>'}).join('')+'</div></section>'}).join('')+'</div>';
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
/* ---------- компактный вид: категории по алфавиту, под каждой «банки + процент» ---------- */
function mini(id){var b=BANKS[id];if(!b)return '';
  return '<span class="mb" title="'+esc(b.n)+'"'+(b.f?' style="--f:'+b.f+'"':'')+'><img src="logos/'+esc(id)+'.svg" alt="'+esc(b.n)+'"><b>'+esc(b.m)+'</b></span>'}
function compactHtml(mo){var g={};
  peek(mo).forEach(function(b){b.items.forEach(function(i){if(!i.cat||!i.pct)return;
    (g[i.cat]=g[i.cat]||[]).push({bank:b.bank,v:parseFloat(i.pct)})})});
  var cats=Object.keys(g).sort(function(a,b){return a.localeCompare(b,'ru')});
  var rowsOf=cats.map(function(c){var M=-1,gr={};
    g[c].forEach(function(r){M=Math.max(M,r.v);(gr[r.v]=gr[r.v]||{v:r.v,banks:[]}).banks.push(r.bank)});
    var multi=g[c].length>1;
    var rows=Object.keys(gr).map(function(k){return gr[k]}).sort(function(a,b){return b.v-a.v});
    rows.forEach(function(q){q.cl=multi?(q.v===M?' best':' dim'):''});
    return {c:c,rows:rows}});
  return '<div class="cmp">'+rowsOf.map(function(o){
    return '<div class="cc"><div class="cn">'+esc(o.c)+'</div><div class="cgs">'+o.rows.map(function(q){
      return '<div class="cg'+q.cl+'"><span class="cw">'+q.banks.map(mini).join('')+'</span><span class="pct">'+fp(q.v)+'%</span></div>'}).join('')+'</div></div>'}).join('')+'</div>'}
function colsHtml(mo,ro){if(C.compact&&(!C.edit||ro)&&hasAny(mo))return compactHtml(mo);
  return '<div class="cols">'+colHtml(mo,ro)+'</div>'}
function histMonths(){return Object.keys(C.data.months).filter(function(mo){return mo<C.ck.cur&&peek(mo).some(function(b){return b.items.length})}).sort().reverse()}
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
  view();if(C.edit)ensureBlank();syncView();
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

export function syncView(){vsw.hidden=C.edit;Array.prototype.forEach.call(vsw.querySelectorAll('button'),function(b){b.setAttribute('aria-pressed',String((b.dataset.v==='compact')===C.compact))})}
