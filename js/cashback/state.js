/* Кешбэк: справочники, состояние и чистые функции над данными.
   Состояние одно на весь раздел и лежит в объекте C, чтобы его могли читать и разметка, и логика. */
import {ls} from '../util.js';
import {clock,label} from '../time.js';

export var BANKS={
  otp:{n:'ОТП',m:'ОТП'},alfa:{n:'Альфа',m:'А'},vtb:{n:'ВТБ',m:'ВТБ'},halva:{n:'Халва',m:'Х',f:'#FF6FAE'},sber:{n:'Сбер',m:'С'}
};
export var PEOPLE=[['zhanna','Жанна'],['denis','Денис']];
export var CATS=['АЗС','Авто и автосервис','Активный отдых','Аптеки','Бытовые услуги','Все покупки','Дом и ремонт','Животные и зоотовары','Здоровье и медицина','Кафе и рестораны','Кино и театры','Книги','Красота','Маркетплейсы','Образование','Одежда и обувь','Путешествия','Развлечения','Связь и интернет','Спорт и фитнес','Супермаркеты','Такси и каршеринг','Техника и электроника','Транспорт','Фастфуд','Цветы','Цифровые товары и подписки'];
export var PCTS=['0.5','1','1.5','2','3','4','5','6','7','8','10','12','15','20','25','30'];

export function empty(){return{months:{},custom:[]}}
export var C={data:empty(),rev:{},dirty:{},edit:false,flight:false,conflict:null,showNext:false,ck:clock(),histOpen:false,histMo:null,hCache:'',snap:'',dirtyBefore:{},kept:false,compact:ls('view')==='compact'};

export function blank(){return{bank:'',items:[{cat:'',pct:''}]}}
export function peek(mo,p){return(C.data.months[mo]&&C.data.months[mo][p])||[]}
export function list(mo,p){var m=C.data.months[mo]||(C.data.months[mo]={zhanna:[],denis:[]});return m[p]||(m[p]=[])}
export function getPart(k){if(k==='custom')return C.data.custom;var a=k.split(':');return peek(a[0],a[1])}
export function setPart(k,v){if(k==='custom'){C.data.custom=v;return}var a=k.split(':'),m=C.data.months[a[0]]||(C.data.months[a[0]]={zhanna:[],denis:[]});m[a[1]]=v}
export function norm(d){return{months:d.months||{},custom:d.custom||[]}}
export function allCats(){return CATS.concat(C.data.custom).sort(function(a,b){return a.localeCompare(b,'ru')})}
export function eachRow(fn){Object.keys(C.data.months).forEach(function(mo){PEOPLE.forEach(function(x){(C.data.months[mo][x[0]]||[]).forEach(function(b){b.items.forEach(function(r){fn(r,mo+':'+x[0])})})})})}
export function pruneOf(d){Object.keys(d.months).forEach(function(mo){PEOPLE.forEach(function(x){var p=x[0],m=d.months[mo];
  m[p]=(m[p]||[]).map(function(b){return{bank:b.bank,items:b.items.filter(function(i){return i.cat&&i.pct})}}).filter(function(b){return b.bank&&b.items.length})})})}
export function prune(){pruneOf(C.data)}
export function partName(k){if(k==='custom')return 'Свои категории';var a=k.split(':');return(a[1]==='zhanna'?'Жанна':'Денис')+', '+label(a[0]).toLowerCase()}
export function partIn(d,k){if(k==='custom')return d.custom||[];var a=k.split(':');return(d.months[a[0]]&&d.months[a[0]][a[1]])||[]}
export function changedParts(){var sd=JSON.parse(C.snap),cd=JSON.parse(JSON.stringify(C.data)),ms={};pruneOf(sd);pruneOf(cd);
  Object.keys(C.data.months).concat(Object.keys(sd.months)).forEach(function(m){ms[m]=1});
  var keys=['custom'];Object.keys(ms).forEach(function(m){PEOPLE.forEach(function(x){keys.push(m+':'+x[0])})});
  return keys.filter(function(k){return JSON.stringify(partIn(cd,k))!==JSON.stringify(partIn(sd,k))})}
export function hasUnsaved(){return(C.edit&&changedParts().length>0)||Object.keys(C.dirty).length>0||!!C.conflict}
export function hasAny(mo){return PEOPLE.some(function(x){return peek(mo,x[0]).some(function(b){return b.items.some(function(i){return i.cat&&i.pct})})})}
