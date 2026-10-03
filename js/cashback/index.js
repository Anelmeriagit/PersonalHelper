/* Кэшбэк: сохранение с версиями и конфликтами, режим редактирования, события страницы */
import {$,esc,ls,lset,nrm} from '../util.js';
import {clock} from '../time.js';
import {api,S,authFail} from '../api.js';
import {dlgAlert,dlgConfirm,dlgPrompt} from '../dialogs.js';
import {C,PEOPLE,empty,blank,list,setPart,getPart,peek,norm,allCats,eachRow,prune,partName,changedParts,hasUnsaved} from './state.js';
import {render,syncView} from './view.js';

export {hasUnsaved};
var stage=$('stage'),st=$('st'),editBtn=$('editBtn'),warn=$('warn'),vsw=$('vsw'),timer=0;

/* ---------- сохранение с версиями ---------- */
function save(parts){if(C.edit){st.textContent='●';return}
  (parts||[]).forEach(function(k){C.dirty[k]=1});clearTimeout(timer);st.textContent='…';timer=setTimeout(flush,400)}
function flush(ka){
  if(C.flight||C.conflict)return;
  var ks=Object.keys(C.dirty);if(!ks.length)return;
  var payload={parts:{}};ks.forEach(function(k){payload.parts[k]={base:C.rev[k]||0,value:getPart(k)}});
  C.dirty={};C.flight=true;
  function back(){ks.forEach(function(k){C.dirty[k]=1})}
  api('PUT','/api/data',payload,ka).then(function(r){return r.json().catch(function(){return{}}).then(function(j){
    C.flight=false;
    if(r.status===401){back();authFail();return}
    if(r.status===400){st.textContent='Ошибка';note('Сервер отклонил часть изменений, данные обновлены.');reload();return}
    if(r.status===409&&j.error==='conflict'){C.conflict={parts:j.parts||ks,data:j.data,rev:j.rev};back();showWarn();st.textContent='!';return}
    if(!r.ok){back();st.textContent='Ошибка';return}
    ks.forEach(function(k){C.rev[k]=j.rev[k]});
    if(Object.keys(C.dirty).length)flush();else st.textContent='✓'})
  }).catch(function(){C.flight=false;back();st.textContent='Ошибка'})}
function showWarn(){var c=C.conflict;if(!c){warn.hidden=true;warn.innerHTML='';return}
  warn.hidden=false;
  warn.innerHTML='<p>Не сохранено: «'+c.parts.map(function(k){return esc(partName(k))}).join('», «')+'» изменили на другом устройстве.</p>'+
    '<div class="acts"><button class="btn" data-w="load" type="button">Загрузить актуальную версию</button><button class="btn" data-w="mine" type="button">Перезаписать моей</button></div>'}
function note(msg){warn.hidden=false;warn.innerHTML='<p>'+esc(msg)+'</p>';setTimeout(function(){if(!C.conflict){warn.hidden=true;warn.innerHTML=''}},6000)}
function reload(){api('GET','/api/data').then(function(r){if(r.status===401){authFail();return}if(!r.ok)return;return r.json().then(function(j){if(C.edit||C.conflict||Object.keys(C.dirty).length)return;C.data=norm(j.data);C.rev=j.rev||{};render()})}).catch(function(){})}
function refresh(){
  function busy(){return C.edit||C.flight||C.conflict||Object.keys(C.dirty).length}
  if(!S.loggedIn||busy())return;
  api('GET','/api/data').then(function(r){if(r.status===401){authFail();return}if(!r.ok)return;
    return r.json().then(function(j){if(busy())return;
      if(JSON.stringify(j.rev)!==JSON.stringify(C.rev)){C.data=norm(j.data);C.rev=j.rev;render()}})}).catch(function(){})}

/* ---------- свои категории ---------- */
function validCat(v){return v&&v.length<=40&&!/[<>"'`&\\\u0000-\u001f]/.test(v)}
function bad(){return dlgAlert('Недопустимое название: до 40 символов, без знаков < > " \' & \\')}
function copyCol(p){
  var l=peek(C.ck.cur,p).map(function(b){return{bank:b.bank,items:b.items.filter(function(i){return i.cat&&i.pct}).map(function(i){return{cat:i.cat,pct:i.pct}})}}).filter(function(b){return b.bank&&b.items.length});
  if(!l.length){dlgAlert('В текущем месяце пока нечего копировать');return}
  var k=C.ck.nxt+':'+p;setPart(k,l);save([k]);render()}
function newCat(){return dlgPrompt('Название своей категории (до 40 символов)','').then(function(r){var v=nrm(r);if(!v)return '';
  if(!validCat(v))return bad().then(function(){return ''});
  var ex=allCats().filter(function(c){return c.toLowerCase()===v.toLowerCase()})[0];if(ex)return ex;
  if(C.data.custom.length>=30)return dlgAlert('Можно добавить не больше 30 своих категорий').then(function(){return ''});
  C.data.custom.push(v);return v})}

/* ---------- режим редактирования ---------- */
function enterEdit(){if(C.edit)return;C.snap=JSON.stringify(C.data);C.dirtyBefore=Object.assign({},C.dirty);C.edit=true;editBtn.setAttribute('aria-pressed','true');render()}
function leaveEdit(){C.edit=false;editBtn.setAttribute('aria-pressed','false');st.textContent=''}
function saveEdit(){prune();var parts=changedParts();leaveEdit();render();if(parts.length)save(parts)}
function discardEdit(){(changedParts().length?dlgConfirm('Выйти без сохранения? Внесённые изменения будут потеряны.'):Promise.resolve(true)).then(function(ok){if(!ok)return;C.data=JSON.parse(C.snap);C.dirty=C.dirtyBefore;leaveEdit();render()})}

/* ---------- события ---------- */
function tick(){var n=clock();if(n.cur===C.ck.cur&&n.late===C.ck.late&&n.day===C.ck.day)return;
  var rolled=n.cur!==C.ck.cur;C.ck=n;if(S.loggedIn){render();if(rolled)refresh()}}
function leaving(){if(!S.loggedIn||C.flight||C.conflict||!Object.keys(C.dirty).length)return;clearTimeout(timer);flush(true)}

/* ---------- связь с общим каркасом (main.js) ---------- */
export function setStatus(t){st.textContent=t}
export function stopSave(){clearTimeout(timer)}
export function onVisible(){tick();refresh()}
export function onHidden(){leaving()}
export function discardAll(){C.dirty={};C.conflict=null;C.edit=false}
/* сессия закончилась: несохранённое оставляем в памяти вкладки (keep), остальное сбрасываем */
export function loggedOut(keep){C.flight=false;
  if(keep){C.kept=true}else{C.kept=false;C.data=empty();C.dirty={};C.conflict=null;C.rev={};C.edit=false;editBtn.setAttribute('aria-pressed','false');showWarn()}}
/* вход: возвращает true, если в памяти остались несохранённые правки (данные с сервера тогда не затираем) */
export function startSession(j){var kept=C.kept;if(kept)C.kept=false;else{C.data=norm(j.data);C.rev=j.rev||{}}C.ck=clock();return kept}
export function syncEditPressed(){editBtn.setAttribute('aria-pressed',C.edit)}
export function finishBoot(kept){
  if(kept){render();if(C.edit)st.textContent='●';else if(Object.keys(C.dirty).length)flush();return}
  stage.classList.add('first');render();setTimeout(function(){stage.classList.remove('first')},600)}

export function initCashback(){
  warn.addEventListener('click',function(e){var w=e.target.dataset.w;if(!w||!C.conflict)return;
    var c=C.conflict;C.conflict=null;
    c.parts.forEach(function(k){C.rev[k]=c.rev[k]||0;
      if(w==='load'){if(k==='custom')C.data.custom=c.data.custom||[];else{var a=k.split(':');setPart(k,(c.data.months[a[0]]&&c.data.months[a[0]][a[1]])||[])}delete C.dirty[k]}else C.dirty[k]=1});
    showWarn();render();flush()});
  editBtn.addEventListener('click',function(){C.edit?saveEdit():enterEdit()});
  stage.addEventListener('change',function(e){var t=e.target,k=t.dataset.k;if(!k)return;
    var mo=t.dataset.mo,p=t.dataset.p,ex=[mo+':'+p],b=list(mo,p)[+t.dataset.b];
    if(k==='bank'){b.bank=t.value;render()}
    else if(k==='cat'&&t.value==='__new'){var n0=C.data.custom.length;newCat().then(function(n){if(n)b.items[+t.dataset.r].cat=n;if(C.data.custom.length!==n0)ex.push('custom');render();save(ex)});return}
    else{b.items[+t.dataset.r][k]=t.value;t.classList.toggle('ph',!t.value)}
    save(ex)});
  stage.addEventListener('click',function(e){
    var hb=e.target.closest('[data-h]');
    if(hb){var hv=hb.dataset.h;
      if(hv==='toggle'){C.histOpen=!C.histOpen;render();if(C.histOpen)setTimeout(function(){var b=$('hBtn');if(b.scrollIntoView)b.scrollIntoView({behavior:'smooth',block:'start'})},80);return}
      if(hv==='pick'){C.histMo=hb.dataset.mo;var hbd=$('hBody');hbd.classList.add('swap');setTimeout(function(){hbd.classList.remove('swap')},450);return render()}}
    var m=e.target.closest('[data-m]');
    if(m){var w=m.dataset.m;
      if(w==='yes'){lset('nm-open',C.ck.cur)}else if(w==='hide'){lset('nm-snooze',C.ck.day)}else if(w==='close'){lset('nm-open','')}else if(w==='copy'){return copyCol(m.dataset.p)}
      return render()}
    var t=e.target.closest('[data-act]');if(!t)return;
    var a=t.dataset.act,mo=t.dataset.mo,p=t.dataset.p,i=+t.dataset.b,j=+t.dataset.r,key=mo+':'+p;
    if(a==='save')return saveEdit();
    if(a==='discard')return discardEdit();
    if(a==='add')return enterEdit();
    if(a==='rc'){var old=C.data.custom[i],ch={custom:1};
      return dlgPrompt('Новое название',old).then(function(r){var v=nrm(r),w=Promise.resolve();
        if(v&&v!==old){if(!validCat(v))w=bad();
          else if(allCats().some(function(c){return c!==old&&c.toLowerCase()===v.toLowerCase()}))w=dlgAlert('Такая категория уже есть');
          else{C.data.custom[i]=v;eachRow(function(r,k){if(r.cat===old){r.cat=v;ch[k]=1}})}}
        return w.then(function(){save(Object.keys(ch));render()})})}
    if(a==='dc'){var c0=C.data.custom[i],n=0,ch2={custom:1};eachRow(function(r){if(r.cat===c0)n++});
      return(n?dlgConfirm('Категория «'+c0+'» используется в строках: '+n+'. Они станут пустыми. Удалить?'):Promise.resolve(true)).then(function(ok){
        if(ok){eachRow(function(r,k){if(r.cat===c0){r.cat='';ch2[k]=1}});C.data.custom.splice(i,1)}
        save(Object.keys(ch2));render()})}
    var l=list(mo,p),parts=[];
    if(a==='addr'){l[i].items.push({cat:'',pct:''});parts=[key]}
    if(a==='addb'){l.push(blank());parts=[key]}
    if(a==='delr'){l[i].items.splice(j,1);if(!l[i].items.length)l[i].items.push({cat:'',pct:''});parts=[key]}
    if(a==='delb'){l.splice(i,1);if(!l.length)l.push(blank());parts=[key]}
    save(parts);render()});
  window.addEventListener('beforeunload',function(e){if(C.edit&&changedParts().length){e.preventDefault();e.returnValue=''}});
  vsw.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;C.compact=b.dataset.v==='compact';lset('view',C.compact?'compact':'blocks');render()});
}
