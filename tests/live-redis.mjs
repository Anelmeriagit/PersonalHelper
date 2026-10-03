// Проверка НАСТОЯЩЕГО Redis (Upstash): атомарные скрипты версии документа и счётчика, SET NX.
// Заглушка tests/redis.mjs Lua не исполняет, поэтому этот прогон нужен один раз после подключения базы и после правок скриптов в api/_db.js.
// Запуск (PowerShell): $env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; node tests/live-redis.mjs
// Пишет только ключи с префиксом selftest<время>: и удаляет их в конце. Значения переменных нигде не печатаются.
process.env.DB_PREFIX = 'selftest' + Date.now();
const db = await import('../api/_db.js');
let bad = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };
const kx = db.key('doc', 'x'), ky = db.key('doc', 'y'), kh = db.key('hit'), kn = db.key('n');
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
} catch (e) { console.log('FAIL исключение:', e.name, e.message); bad++; }
finally { try { await db.del(kx, ky, db.key('doc', 'z'), kh, kn); } catch { /* нечего чистить */ } }
console.log(bad ? `\nПровалено: ${bad}` : '\nВсе проверки настоящего Redis пройдены');
process.exit(bad ? 1 : 0);
