/* Кэшбэк: справочники, состояние и чистые функции над данными.
   Состояние одно на весь раздел и лежит в объекте C, чтобы его могли читать и разметка, и логика. */
import {ls,nrm} from '../util.js';
import {clock,label} from '../time.js';

export var BANKS={
  otp:{n:'ОТП',m:'ОТП'},alfa:{n:'Альфа',m:'А'},vtb:{n:'ВТБ',m:'ВТБ'},halva:{n:'Халва',m:'Х',f:'#FF6FAE'},sber:{n:'Сбер',m:'С'}
};
export var CATS=['АЗС','Авто и автосервис','Активный отдых','Аптеки','Бытовые услуги','Все покупки','Дом и ремонт','Животные и зоотовары','Здоровье и медицина','Кафе и рестораны','Кино и театры','Книги','Красота','Маркетплейсы','Образование','Одежда и обувь','Путешествия','Развлечения','Связь и интернет','Спорт и фитнес','Супермаркеты','Такси и каршеринг','Техника и электроника','Транспорт','Фастфуд','Цветы','Цифровые товары и подписки'];
export var PCTS=['0.5','1','1.5','2','3','4','5','6','7','8','10','12','15','20','25','30'];

export function empty(){return{months:{},custom:[]}}
export var C={data:empty(),rev:{},dirty:{},edit:false,flight:false,conflict:null,showNext:false,ck:clock(),histOpen:false,histMo:null,hCache:'',snap:'',dirtyBefore:{},compact:ls('view')==='compact',partner:null};

export function blank(){return{bank:'',items:[{cat:'',pct:''}]}}
export function peek(mo){return C.data.months[mo]||[]}
export function list(mo){return C.data.months[mo]||(C.data.months[mo]=[])}
export function getPart(k){return k==='custom'?C.data.custom:peek(k)}
export function setPart(k,v){if(k==='custom')C.data.custom=v;else C.data.months[k]=v}
export function norm(d){return{months:d.months||{},custom:d.custom||[]}}
export function allCats(){return CATS.concat(C.data.custom).sort(function(a,b){return a.localeCompare(b,'ru')})}
export function eachRow(fn){Object.keys(C.data.months).forEach(function(mo){C.data.months[mo].forEach(function(b){b.items.forEach(function(r){fn(r,mo)})})})}
export function pruneOf(d){Object.keys(d.months).forEach(function(mo){
  d.months[mo]=(d.months[mo]||[]).map(function(b){return{bank:b.bank,items:b.items.filter(function(i){return i.cat&&i.pct})}}).filter(function(b){return b.bank&&b.items.length})})}
export function prune(){pruneOf(C.data)}
export function partName(k){return k==='custom'?'Свои категории':label(k)}
export function partIn(d,k){return k==='custom'?(d.custom||[]):(d.months[k]||[])}
export function changedParts(){var sd=JSON.parse(C.snap),cd=JSON.parse(JSON.stringify(C.data)),ms={};pruneOf(sd);pruneOf(cd);
  Object.keys(C.data.months).concat(Object.keys(sd.months)).forEach(function(m){ms[m]=1});
  var keys=['custom'].concat(Object.keys(ms));
  return keys.filter(function(k){return JSON.stringify(partIn(cd,k))!==JSON.stringify(partIn(sd,k))})}
export function hasUnsaved(){return(C.edit&&changedParts().length>0)||Object.keys(C.dirty).length>0||!!C.conflict}
export function hasAnyL(l){return l.some(function(b){return b.items.some(function(i){return i.cat&&i.pct})})}
export function hasAny(mo){return hasAnyL(peek(mo))}
/* Кэшбэк партнёра (соединённый аккаунт), только на просмотр: часть `partner` ответа GET /api/data → null (нет связи) или {name, months}.
   Живёт отдельно от C.data: в сохранение, правку и снимки не попадает. */
export var PDEF='Helper User';
export function normPartner(p){if(!p||p.linked!==true)return null;
  var src=p.data&&typeof p.data.months==='object'&&p.data.months?p.data.months:{},ms={};
  Object.keys(src).forEach(function(k){if(Array.isArray(src[k]))ms[k]=src[k].filter(function(b){return b&&Array.isArray(b.items)})});
  return{name:nrm(typeof p.name==='string'?p.name:'').slice(0,32)||PDEF,months:ms}}
export function ppeek(mo){return C.partner&&C.partner.months[mo]||[]}
