/* Переключатель светлой и тёмной темы (первичную тему без мигания ставит theme.js в <head>) */
import {$,ls,lset,IC} from './util.js';

var root=document.documentElement,tb=$('themeBtn');
function setTheme(t){root.setAttribute('data-theme',t);tb.innerHTML=t==='dark'?IC.sun:IC.moon;
  document.querySelector('meta[name=theme-color]').setAttribute('content',t==='dark'?'#0b0d10':'#f7f8fa')}
export function initTheme(){
  setTheme(ls('theme')||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'));
  tb.addEventListener('click',function(){var t=root.getAttribute('data-theme')==='dark'?'light':'dark';setTheme(t);lset('theme',t)});
}
