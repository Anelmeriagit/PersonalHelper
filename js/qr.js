/* Минимальный генератор QR-кода для гостя: байтовый режим (UTF-8), уровень коррекции M, версии 1–40, маска выбирается автоматически.
   Парный файл к api/_qr.js (там тот же алгоритм для аккаунта): менять только вместе, результат обоих должен совпадать до бита.
   Нужен потому, что пароль Wi-Fi гостя на сервер не уходит: матрицу строит сам браузер. Зависимостей нет. */

var ECC_PER_BLOCK=[-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28];
var NUM_BLOCKS=[-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49];

function rawModules(v){var r=(16*v+128)*v+64,a;
  if(v>=2){a=Math.floor(v/7)+2;r-=(25*a-10)*a-55;if(v>=7)r-=36}
  return r}
function dataCodewords(v){return Math.floor(rawModules(v)/8)-ECC_PER_BLOCK[v]*NUM_BLOCKS[v]}

/* UTF-8 в байты (как Buffer.from(s,'utf8'): непарный суррогат даёт U+FFFD); длина нужна и проверке названия сети (до 32 байт) */
export function utf8Bytes(s){var out=[],str=String(s),i,c,d;
  for(i=0;i<str.length;i++){c=str.charCodeAt(i);
    if(c>=0xd800&&c<0xdc00&&i+1<str.length&&(d=str.charCodeAt(i+1))>=0xdc00&&d<0xe000){c=0x10000+((c-0xd800)<<10)+(d-0xdc00);i++}
    else if(c>=0xd800&&c<0xe000)c=0xfffd;
    if(c<0x80)out.push(c);
    else if(c<0x800)out.push(0xc0|(c>>6),0x80|(c&63));
    else if(c<0x10000)out.push(0xe0|(c>>12),0x80|((c>>6)&63),0x80|(c&63));
    else out.push(0xf0|(c>>18),0x80|((c>>12)&63),0x80|((c>>6)&63),0x80|(c&63))}
  return out}

/* ---------- Рид-Соломон над GF(256), полином 0x11D ---------- */
function mul(x,y){var z=0,i;
  for(i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11d);z^=((y>>>i)&1)*x}
  return z}
function divisor(deg){var r=[],i,j,root=1;
  for(i=0;i<deg;i++)r.push(0);
  r[deg-1]=1;
  for(i=0;i<deg;i++){
    for(j=0;j<r.length;j++){r[j]=mul(r[j],root);if(j+1<r.length)r[j]^=r[j+1]}
    root=mul(root,2)}
  return r}
function remainder(data,div){var r=div.map(function(){return 0}),i,f;
  for(i=0;i<data.length;i++){f=data[i]^r.shift();r.push(0);
    div.forEach(function(c,k){r[k]^=mul(c,f)})}
  return r}

/* ---------- Кодирование данных ---------- */
function encodeData(bytes){var ver=1,bits=[],cap,out,pad,i;
  for(;;ver++){
    if(ver>40)throw new RangeError('Данные слишком длинные для QR');
    if(4+(ver<=9?8:16)+bytes.length*8<=dataCodewords(ver)*8)break}
  function put(val,len){var k;for(k=len-1;k>=0;k--)bits.push((val>>>k)&1)}
  put(4,4);
  put(bytes.length,ver<=9?8:16);
  bytes.forEach(function(b){put(b,8)});
  cap=dataCodewords(ver)*8;
  put(0,Math.min(4,cap-bits.length));
  put(0,(8-(bits.length%8))%8);
  for(pad=0xec;bits.length<cap;pad^=0xec^0x11)put(pad,8);
  out=[];for(i=0;i<bits.length/8;i++)out.push(0);
  bits.forEach(function(b,k){out[k>>>3]|=b<<(7-(k&7))});
  return{ver:ver,data:out}}

function addEccAndInterleave(data,ver){
  var nb=NUM_BLOCKS[ver],eb=ECC_PER_BLOCK[ver],raw=Math.floor(rawModules(ver)/8),
    nShort=nb-(raw%nb),shortLen=Math.floor(raw/nb),div=divisor(eb),blocks=[],i,k=0,dat,ecc,out=[],j;
  for(i=0;i<nb;i++){
    dat=data.slice(k,k+shortLen-eb+(i<nShort?0:1));
    k+=dat.length;
    ecc=remainder(dat,div);
    if(i<nShort)dat.push(0);
    blocks.push(dat.concat(ecc))}
  for(i=0;i<blocks[0].length;i++){
    for(j=0;j<blocks.length;j++){if(i!==shortLen-eb||j>=nShort)out.push(blocks[j][i])}}
  return out}

/* ---------- Матрица ---------- */
function bit(x,i){return((x>>>i)&1)!==0}
function grid(size){var g=[],y,x,row;for(y=0;y<size;y++){row=[];for(x=0;x<size;x++)row.push(false);g.push(row)}return g}

function build(ver,codewords){
  var size=ver*4+17,mod=grid(size),fn=grid(size),i,na,pos=[],step,p;
  function setFn(x,y,dark){mod[y][x]=dark;fn[y][x]=true}
  for(i=0;i<size;i++){setFn(6,i,i%2===0);setFn(i,6,i%2===0)}
  function finder(cx,cy){var dx,dy,d,x,y;
    for(dy=-4;dy<=4;dy++)for(dx=-4;dx<=4;dx++){
      d=Math.max(Math.abs(dx),Math.abs(dy));x=cx+dx;y=cy+dy;
      if(x>=0&&x<size&&y>=0&&y<size)setFn(x,y,d!==2&&d!==4)}}
  finder(3,3);finder(size-4,3);finder(3,size-4);

  na=ver===1?0:Math.floor(ver/7)+2;
  if(na){
    step=ver===32?26:Math.ceil((ver*4+4)/(na*2-2))*2;
    pos.push(6);
    for(p=size-7;pos.length<na;p-=step)pos.splice(1,0,p)}
  pos.forEach(function(px,a){pos.forEach(function(py,b){var dx,dy;
    if((a===0&&b===0)||(a===0&&b===na-1)||(a===na-1&&b===0))return;
    for(dy=-2;dy<=2;dy++)for(dx=-2;dx<=2;dx++)setFn(px+dx,py+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1)})});

  function drawFormat(mask){
    var data=(0<<3)|mask,rem=data,k,bits; /* уровень M = 00 */
    for(k=0;k<10;k++)rem=(rem<<1)^((rem>>>9)*0x537);
    bits=((data<<10)|rem)^0x5412;
    for(k=0;k<=5;k++)setFn(8,k,bit(bits,k));
    setFn(8,7,bit(bits,6));setFn(8,8,bit(bits,7));setFn(7,8,bit(bits,8));
    for(k=9;k<15;k++)setFn(14-k,8,bit(bits,k));
    for(k=0;k<8;k++)setFn(size-1-k,8,bit(bits,k));
    for(k=8;k<15;k++)setFn(8,size-15+k,bit(bits,k));
    setFn(8,size-8,true)}
  drawFormat(0);
  if(ver>=7){
    var rem=ver,vb,k,a,b;
    for(k=0;k<12;k++)rem=(rem<<1)^((rem>>>11)*0x1f25);
    vb=(ver<<12)|rem;
    for(k=0;k<18;k++){a=size-11+(k%3);b=Math.floor(k/3);setFn(a,b,bit(vb,k));setFn(b,a,bit(vb,k))}}

  var n=0,right,vert,j,x,y,up;
  for(right=size-1;right>=1;right-=2){
    if(right===6)right=5;
    for(vert=0;vert<size;vert++)for(j=0;j<2;j++){
      x=right-j;up=((right+1)&2)===0;y=up?size-1-vert:vert;
      if(!fn[y][x]&&n<codewords.length*8){mod[y][x]=bit(codewords[n>>>3],7-(n&7));n++}}}
  return{size:size,mod:mod,fn:fn,drawFormat:drawFormat}}

var MASKS=[
  function(x,y){return(x+y)%2===0},
  function(x,y){return y%2===0},
  function(x){return x%3===0},
  function(x,y){return(x+y)%3===0},
  function(x,y){return(Math.floor(x/3)+Math.floor(y/2))%2===0},
  function(x,y){return((x*y)%2)+((x*y)%3)===0},
  function(x,y){return(((x*y)%2)+((x*y)%3))%2===0},
  function(x,y){return(((x+y)%2)+((x*y)%3))%2===0}];
function applyMask(q,m){var x,y;
  for(y=0;y<q.size;y++)for(x=0;x<q.size;x++)if(!q.fn[y][x]&&MASKS[m](x,y))q.mod[y][x]=!q.mod[y][x]}

function penalty(mod,size){var p=0,lines=[],a,y,x,c,dark=0,total=size*size;
  function col(i){return mod.map(function(r){return Number(r[i])}).join('')}
  for(a=0;a<size;a++){lines.push(mod[a].map(Number).join(''));lines.push(col(a))}
  lines.forEach(function(s){
    var runs=s.match(/0+|1+/g),f=s.match(/(?=(10111010000|00001011101))/g);
    runs.forEach(function(r){if(r.length>=5)p+=3+(r.length-5)});
    if(f)p+=f.length*40});
  for(y=0;y<size-1;y++)for(x=0;x<size-1;x++){
    c=mod[y][x];
    if(c===mod[y][x+1]&&c===mod[y+1][x]&&c===mod[y+1][x+1])p+=3}
  mod.forEach(function(r){r.forEach(function(v){if(v)dark++})});
  p+=(Math.ceil(Math.abs(dark*20-total*10)/total)-1)*10;
  return p}

/* Возвращает {size, rows}: rows — массив строк из '0' и '1' (без тихой зоны), как makeQr в api/_qr.js */
export function makeQr(text){
  var bytes=utf8Bytes(text),e=encodeData(bytes),q=build(e.ver,addEccAndInterleave(e.data,e.ver)),best=0,bestP=Infinity,m,p;
  for(m=0;m<8;m++){
    applyMask(q,m);q.drawFormat(m);
    p=penalty(q.mod,q.size);
    if(p<bestP){best=m;bestP=p}
    applyMask(q,m)} /* снять маску */
  applyMask(q,best);q.drawFormat(best);
  return{size:q.size,rows:q.mod.map(function(r){return r.map(function(c){return c?'1':'0'}).join('')})}}
