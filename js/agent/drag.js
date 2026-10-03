/* «Агент»: перетаскивание строк (pointer events: мышь и палец) и перестановка стрелками с клавиатуры */
import {$} from '../util.js';
import {A,agRow,agNote} from './state.js';

var agBody=$('agBody'),onOrder=function(){};
function agSyncOrder(){if(!A.ag)return;var els=agBody.querySelectorAll('.agr'),next=[],i,r,changed=false;
  for(i=0;i<els.length;i++){r=agRow(els[i].getAttribute('data-id'));if(r)next.push(r)}
  if(next.length!==A.ag.rows.length)return;
  for(i=0;i<next.length;i++)if(next[i]!==A.ag.rows[i])changed=true;
  if(changed){A.ag.rows=next;onOrder()}}
function agDragMove(y){var row=A.drag.row,h,c,p,n,b;
  row.style.transform='none';h=row.getBoundingClientRect().height;c=y-A.drag.grab+h/2;
  for(;;){p=row.previousElementSibling;if(!p)break;b=p.getBoundingClientRect();if(c<b.top+b.height/2)row.parentNode.insertBefore(row,p);else break}
  for(;;){n=row.nextElementSibling;if(!n)break;b=n.getBoundingClientRect();if(c>b.top+b.height/2)row.parentNode.insertBefore(row,n.nextSibling);else break}
  row.style.transform='translateY('+(y-A.drag.grab-row.getBoundingClientRect().top)+'px)'}
function agDragEnd(e){if(!A.drag||e.pointerId!==A.drag.id)return;var d=A.drag;A.drag=null;
  d.row.classList.remove('drag');d.row.style.transform='';try{d.grip.releasePointerCapture(d.id)}catch(x){}agSyncOrder()}
/* onChange вызывается, когда порядок строк изменился */
export function initDrag(fn){
  onOrder=fn;
  agBody.addEventListener('pointerdown',function(e){var g=e.target.closest('button[data-ag="grip"]');if(!g||!A.ag||A.drag||(e.pointerType==='mouse'&&e.button!==0))return;
    var row=g.closest('.agr');e.preventDefault();
    A.drag={row:row,grip:g,id:e.pointerId,grab:e.clientY-row.getBoundingClientRect().top};
    row.classList.add('drag');try{g.setPointerCapture(e.pointerId)}catch(x){}agDragMove(e.clientY)});
  agBody.addEventListener('pointermove',function(e){if(A.drag&&e.pointerId===A.drag.id)agDragMove(e.clientY)});
  agBody.addEventListener('pointerup',agDragEnd);
  agBody.addEventListener('pointercancel',agDragEnd);
  agBody.addEventListener('keydown',function(e){var g=e.target.closest('button[data-ag="grip"]');if(!g||!A.ag||(e.key!=='ArrowUp'&&e.key!=='ArrowDown'))return;
    e.preventDefault();var row=g.closest('.agr'),sib=e.key==='ArrowUp'?row.previousElementSibling:row.nextElementSibling;if(!sib)return;
    if(e.key==='ArrowUp')row.parentNode.insertBefore(row,sib);else row.parentNode.insertBefore(sib,row);
    g.focus();agSyncOrder();var els=agBody.querySelectorAll('.agr'),i=Array.prototype.indexOf.call(els,row)+1;agNote('Позиция '+i+' из '+els.length)});
}
