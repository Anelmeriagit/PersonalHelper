/* Общие мелочи: DOM, экранирование, разметка <option>, localStorage, иконки */
export var IC={pen:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',out:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',moon:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',sun:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>',x:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>'};
export function $(id){return document.getElementById(id)}
export function esc(v){return String(v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
export function fp(v){return String(v).replace('.',',')}
export function cls(v){return v?'':' class="ph"'}
export function opts(items,sel,ph,used){return '<option value="" disabled hidden'+(sel?'':' selected')+'>'+ph+'</option>'+items.map(function(v){var id=v.id||v,t=v.t||v;
  return '<option value="'+esc(id)+'"'+(id===sel?' selected':'')+(used&&used.indexOf(id)>-1&&id!==sel?' disabled':'')+'>'+esc(t)+'</option>'}).join('')}
export function nrm(v){return String(v||'').replace(/\s+/g,' ').trim()}
export function cap(s){return s.charAt(0).toUpperCase()+s.slice(1)}
export function ls(k){try{return localStorage.getItem(k)}catch(e){return null}}
export function lset(k,v){try{localStorage.setItem(k,v)}catch(e){}}
export function ldel(k){try{localStorage.removeItem(k)}catch(e){}}
