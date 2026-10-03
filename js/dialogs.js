/* Диалоги вместо alert/confirm/prompt */
import {$} from './util.js';
var dlg=$('dlg');
function dlgOpen(msg,mode,def){return new Promise(function(res){
  dlg.innerHTML='<form method="dialog"><p id="dlgMsg"></p>'+(mode==='prompt'?'<input id="dlgIn" maxlength="40" autocomplete="off" aria-label="Значение">':'')+'<div class="acts">'+(mode==='alert'?'':'<button class="btn" id="dlgNo" type="button">Отмена</button>')+'<button class="done" value="ok" type="submit">ОК</button></div></form>';
  $('dlgMsg').textContent=msg;var inp=$('dlgIn'),no=$('dlgNo');if(inp)inp.value=def||'';
  if(no)no.addEventListener('click',function(){dlg.close('cancel')});
  dlg.returnValue='';
  dlg.onclose=function(){var ok=dlg.returnValue==='ok';res(mode==='prompt'?(ok?inp.value:null):ok)};
  dlg.showModal();if(inp)inp.focus()})}
export function dlgAlert(m){return dlgOpen(m,'alert').then(function(){})}
export function dlgConfirm(m){return dlgOpen(m,'confirm')}
export function dlgPrompt(m,d){return dlgOpen(m,'prompt',d)}
