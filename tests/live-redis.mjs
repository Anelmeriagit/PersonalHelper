// Проверка НАСТОЯЩЕГО Redis (Upstash): атомарные скрипты версии документа, счётчика и одноразового значения (take), SET NX, множество (SADD/SREM/SMEMBERS), SCAN с MATCH и COUNT (нужен скрипту scripts/purge-3b.mjs), TYPE, HGETALL, PTTL и круг резервной копии api/_backup.js (этап 4.1: чтение, шифрование, восстановление).
// Заглушка tests/redis.mjs Lua не исполняет, поэтому этот прогон нужен один раз после подключения базы и после правок скриптов в api/_db.js.
// Запуск (PowerShell): $env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; node tests/live-redis.mjs
// Пишет только ключи с префиксом selftest<время>: и удаляет их в конце. Значения переменных нигде не печатаются.
process.env.DB_PREFIX = 'selftest' + Date.now();
const { randomBytes } = await import('node:crypto');
process.env.BACKUP_KEY = randomBytes(32).toString('hex'); // одноразовый ключ только для этой проверки, нигде не печатается
const db = await import('../api/_db.js');
const bk = await import('../api/_backup.js');
let bad = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };
const kt = db.key('tgt', 'x');
const kx = db.key('doc', 'x'), ky = db.key('doc', 'y'), kh = db.key('hit'), kn = db.key('n'), ks = db.key('tgs');
try {
  ok((await db.getDoc(kx)).v === 0, 'документа нет: версия 0');
  ok(await db.putDoc(kx, { a: 'Ёж "и" \\' }, 0) === 1, 'создание: версия 1');
  ok(await db.putDoc(kx, { a: 2 }, 0) === null, 'повторное создание отвергнуто');
  ok(await db.putDoc(kx, { a: 3 }, 1) === 2, 'обновление с верной версией: версия 2');
  ok(await db.putDoc(kx, { a: 4 }, 1) === null, 'устаревшая версия отвергнута');
  const g = await db.getDoc(kx);
  ok(g.v === 2 && g.doc.a === 3, 'прочитано то, что записано');
  const g0 = await (async () => { await db.putDoc(db.key('doc', 'z'), { s: 'Ёж "и" \\' }, 0); return db.getDoc(db.key('doc', 'z')); })();
  ok(g0.doc.s === 'Ёж "и" \\', 'кириллица, кавычки и обратная косая черта не портятся');
  const rs = await Promise.all([db.putDoc(ky, {}, 0), db.putDoc(ky, {}, 0)]);
  ok(rs.filter((x) => x === null).length === 1, 'две параллельные записи: проходит одна');
  ok(await db.hit(kh, 60000) === 1 && await db.hit(kh, 60000) === 2, 'счётчик растёт');
  const c = await db.count(kh);
  ok(c.n === 2 && c.ttl > 0 && c.ttl <= 60000, 'у счётчика есть срок жизни (ttl ' + c.ttl + ' мс)');
  ok((await db.setNx(kn, 'a')) === true && (await db.setNx(kn, 'b')) === false, 'SET NX: второй раз отказ');
  await db.cmd('SET', kt, 'v1', 'EX', 60);
  const tk = await Promise.all([db.take(kt), db.take(kt)]);
  ok(tk.filter((x) => x === 'v1').length === 1 && tk.filter((x) => x === null).length === 1, 'take: значение достаётся одному из двух параллельных запросов');
  ok((await db.take(kt)) === null && (await db.take(db.key('tgt', 'нет'))) === null, 'take: после выдачи ключа нет, несуществующий даёт null');
  // множество tgs (этап 3b): SADD, SREM, SMEMBERS
  ok(await db.cmd('SADD', ks, 'a1', 'b2') === 2 && await db.cmd('SADD', ks, 'a1') === 0, 'SADD: повтор не добавляет');
  ok((await db.cmd('SMEMBERS', ks)).sort().join() === 'a1,b2', 'SMEMBERS отдаёт все элементы');
  ok(await db.cmd('SREM', ks, 'a1', 'нет') === 1 && (await db.cmd('SMEMBERS', ks)).join() === 'b2', 'SREM убирает только существующее');
  ok(await db.cmd('SREM', ks, 'b2') === 1 && (await db.cmd('SMEMBERS', ks)).length === 0, 'пустое множество: SMEMBERS даёт []');
  // SCAN с MATCH и COUNT (scripts/purge-3b.mjs): обход по курсору находит все свои ключи doc: и не находит чужие
  const seen = new Set();
  let cur = '0';
  do { const r = await db.cmd('SCAN', cur, 'MATCH', db.key('doc', '*'), 'COUNT', 1); cur = String(r[0]); for (const k of r[1]) seen.add(k); } while (cur !== '0');
  ok(seen.has(kx) && seen.has(ky) && seen.has(db.key('doc', 'z')) && !seen.has(kh) && !seen.has(ks), 'SCAN MATCH COUNT: курсор доходит до 0, находит doc:x, doc:y, doc:z и не находит чужие ключи (нашлось ' + seen.size + ')');
  // этап 4.1: чтение типов и круг копии на настоящем Redis (ответы TYPE, PTTL, HGETALL у Upstash REST)
  await db.cmd('SADD', ks, 'a1', 'b2');
  ok(await db.cmd('TYPE', kx) === 'hash' && await db.cmd('TYPE', kn) === 'string' && await db.cmd('TYPE', ks) === 'set' && await db.cmd('TYPE', db.key('нет')) === 'none', 'TYPE: hash, string, set, none');
  const ga = await db.cmd('HGETALL', kx);
  ok(Array.isArray(ga) && ga.length === 4 && ga.includes('d') && ga.includes('v'), 'HGETALL: плоский массив [поле, значение, ...] (получено ' + (Array.isArray(ga) ? 'массив из ' + ga.length : typeof ga) + ')');
  ok(await db.cmd('PTTL', kn) === -1 && await db.cmd('PTTL', db.key('нет')) === -2 && (await db.cmd('PTTL', kh)) > 0, 'PTTL: -1 без срока, -2 нет ключа, больше 0 со сроком');
  const got = [];
  let bc = '0', bstat = null;
  do { const r = await bk.readBatch(bc, { count: 2 }); got.push(...r.recs); bc = r.cursor; bstat = r.stats; if (r.done) break; } while (true);
  const gk = got.map((r) => r.k).sort().join();
  ok(['doc:x', 'doc:y', 'doc:z', 'hit', 'n', 'tgs'].every((x) => gk.split(',').includes(x)), 'копия: найдены все свои ключи (' + gk + ')');
  const part = bk.decodePart(bk.encodePart({ snap: 'selftest-0001', n: 0, recs: got }), { snap: 'selftest-0001', n: 0 });
  ok(part.recs.length === got.length, 'шифрование и расшифровка части на настоящих данных');
  const rpx = db.prefix() + 'rst';
  for (const r of part.recs) await db.pipe(bk.restoreCmds(r, rpx));
  const kr = (...a) => rpx + ':' + a.join(':');
  ok((await db.getDoc(kr('doc', 'x'))).doc.a === 3 && (await db.getDoc(kr('doc', 'x'))).v === 2, 'восстановленный документ совпадает (версия и содержимое)');
  ok((await db.cmd('SMEMBERS', kr('tgs'))).sort().join() === 'a1,b2' && (await db.cmd('GET', kr('n'))) === 'a', 'восстановлены множество и строка');
  const tr = await db.cmd('PTTL', kr('hit'));
  ok(tr > 0 && tr <= 60000, 'восстановлен срок жизни (' + tr + ' мс)');
} catch (e) { console.log('FAIL исключение:', e.name, e.message); bad++; }
finally {
  try { // удалить всё, что создала проверка (свой префикс, включая восстановленное в «rst»)
    let c = '0';
    do { const r = await db.cmd('SCAN', c, 'MATCH', bk.globEsc(db.prefix()) + '*', 'COUNT', 100); c = String(r[0]); if (r[1].length) await db.cmd('DEL', ...r[1]); } while (c !== '0');
  } catch { /* нечего чистить */ }
}
console.log(bad ? `\nПровалено: ${bad}` : '\nВсе проверки настоящего Redis пройдены');
process.exit(bad ? 1 : 0);
