// Проверка НАСТОЯЩЕГО Redis (Upstash): атомарные скрипты версии документа, счётчика и одноразового значения (take), SET NX, множество (SADD/SREM/SMEMBERS), SCAN с MATCH и COUNT (нужен скрипту scripts/purge-3b.mjs).
// Заглушка tests/redis.mjs Lua не исполняет, поэтому этот прогон нужен один раз после подключения базы и после правок скриптов в api/_db.js.
// Запуск (PowerShell): $env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; node tests/live-redis.mjs
// Пишет только ключи с префиксом selftest<время>: и удаляет их в конце. Значения переменных нигде не печатаются.
process.env.DB_PREFIX = 'selftest' + Date.now();
const db = await import('../api/_db.js');
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
} catch (e) { console.log('FAIL исключение:', e.name, e.message); bad++; }
finally { try { await db.del(kx, ky, db.key('doc', 'z'), kh, kn, kt, ks); } catch { /* нечего чистить */ } }
console.log(bad ? `\nПровалено: ${bad}` : '\nВсе проверки настоящего Redis пройдены');
process.exit(bad ? 1 : 0);
