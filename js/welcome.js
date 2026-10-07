/* Окно приветствия: один раз на браузер (флаг welcome в localStorage). Текст лежит в index.html (#welcome). */
import {$,ls,lset} from './util.js';
export function initWelcome(){
  var w=$('welcome');
  if(!w||typeof w.showModal!=='function'||ls('welcome')==='1')return;
  w.addEventListener('close',function(){lset('welcome','1')});
  w.showModal();w.scrollTop=0}
