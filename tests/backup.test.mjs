// Этап 4.1: ядро резервной копии (api/_backup.js): шифрование AES-256-GCM, формат части, обход ключей, команды восстановления.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { __reset, __keys, __raw, __putOther, __after, __drop, __cmdLog } from './redis.mjs';
import { setEnv } from './helpers.mjs';

setEnv();
const db = await import('../api/_db.js');
const B = await import('../api/_backup.js');

const KEY1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';
const KEY2 = '00ffeeddccbbaa99887766554433221100f0e0d0c0b0a09080706050403020a1';
const SNAP = 'snap-20261005-ab12';

beforeEach(() => { __reset(); setEnv(); process.env.BACKUP_KEY = KEY1; });

const hex = (n) => n.toString(16).padStart(32, '0');
async function seed() {
  await db.cmd('HSET', 'doc:' + hex(1), 'd', '{"months":{"2026-10":[]}}', 'v', '3');
  await db.cmd('HSET', 'agent:' + hex(1), 'd', 'Привет, мир\nвторая строка', 'v', '1');
  await db.cmd('SET', 'nick:anna', hex(1));
  await db.cmd('SET', 'empty:str', '');
  await db.cmd('SADD', 'tgs', hex(1), hex(2));
  await db.cmd('SET', 'tgt:abcd', hex(1), 'PX', 600000);
  await db.cmd('SET', 'rl:ip:1.2.3.4', '3', 'PX', 900000);
  await db.cmd('SET', 'misc:ttl', 'v', 'PX', 600000); // вид ключа неизвестен: читается через TYPE и PTTL, срок жизни сохраняется
}
const isTemp = (k) => /^(tgt|rl|tgp):/.test(k);
async function readAll(count) {
  const recs = []; const st = { scanned: 0, copied: 0, gone: 0, changed: 0, foreign: 0, temp: 0, other: {} };
  let cur = '0';
  do {
    const r = await B.readBatch(cur, { count });
    recs.push(...r.recs); cur = r.cursor;
    for (const k of ['scanned', 'copied', 'gone', 'changed', 'foreign', 'temp']) st[k] += r.stats[k];
    for (const [t, n] of Object.entries(r.stats.other)) st.other[t] = (st.other[t] || 0) + n;
    if (r.done) break;
  } while (true);
  return { recs, st };
}
const byKey = (recs) => Object.fromEntries(recs.map((r) => [r.k, r]));
async function dump(pfx) {
  const out = {};
  for (const k of __keys().filter((x) => x.startsWith(pfx))) {
    const type = await db.cmd('TYPE', k);
    const v = type === 'string' ? await db.cmd('GET', k) : type === 'hash' ? await db.cmd('HGETALL', k) : (await db.cmd('SMEMBERS', k)).sort();
    out[k.slice(pfx.length)] = { type, v, ttl: Number(await db.cmd('PTTL', k)) };
  }
  return out;
}

/* ---------- ключ ---------- */
test('BACKUP_KEY: нет, короткий, не hex, слишком простой — ошибка config; нормальный принят', () => {
  for (const bad of [undefined, '', 'abc', KEY1.slice(1), KEY1 + '0', 'z'.repeat(64), '0'.repeat(64), 'ab'.repeat(32)]) {
    if (bad === undefined) delete process.env.BACKUP_KEY; else process.env.BACKUP_KEY = bad;
    assert.equal(B.backupReady(), false, String(bad));
    assert.throws(() => B.backupKey(), (e) => e.name === 'BackupError' && e.kind === 'config');
  }
  process.env.BACKUP_KEY = ' ' + KEY1.toUpperCase() + '\n';
  assert.equal(B.backupReady(), true);
  assert.equal(B.backupKey().length, 32);
});

test('в сообщении об ошибке ключа нет значения ключа', () => {
  process.env.BACKUP_KEY = 'q'.repeat(64);
  try { B.backupKey(); assert.fail('должна быть ошибка'); } catch (e) { assert.ok(!e.message.includes('qqqq')); }
});

/* ---------- шифрование ---------- */
test('seal/open: круг, разный iv, шифртекст не содержит открытый текст', () => {
  const plain = Buffer.from('очень-секретное-значение-12345');
  const a = B.seal(plain, 'x|0'), b = B.seal(plain, 'x|0');
  assert.deepEqual(B.open(a, 'x|0'), plain);
  assert.notDeepEqual(a, b, 'iv должен быть новым при каждом шифровании');
  assert.equal(a.includes(plain), false);
  assert.equal(a.subarray(0, 4).toString(), 'PHB1');
  assert.deepEqual(B.open(B.seal(Buffer.alloc(0), 'e'), 'e'), Buffer.alloc(0));
});

test('open: другой ключ → key; изменённый байт или другой aad → tamper; чужой или обрезанный файл → format', () => {
  const buf = B.seal(Buffer.from('данные'), 'x|0');
  process.env.BACKUP_KEY = KEY2;
  assert.throws(() => B.open(buf, 'x|0'), (e) => e.kind === 'key');
  process.env.BACKUP_KEY = KEY1;
  const flip = (i) => { const c = Buffer.from(buf); c[i] ^= 1; return c; };
  for (const i of [buf.length - 1, 30, 10]) assert.throws(() => B.open(flip(i), 'x|0'), (e) => e.kind === 'tamper', 'байт ' + i);
  assert.throws(() => B.open(buf, 'x|1'), (e) => e.kind === 'tamper');
  assert.throws(() => B.open(buf.subarray(0, 20), 'x|0'), (e) => e.kind === 'format');
  assert.throws(() => B.open(Buffer.from('просто текст, не копия'), 'x|0'), (e) => e.kind === 'format');
  assert.throws(() => B.open('строка', 'x|0'), (e) => e.kind === 'format');
});

/* ---------- формат части ---------- */
const SAMPLE = [
  { k: 'doc:1', t: 'h', v: [['d', '{"a":"б"}'], ['v', '2']] },
  { k: 'nick:anna', t: 's', v: 'id\nс переводом строки', ttl: 12345 },
  { k: 'empty', t: 's', v: '' },
  { k: 'tgs', t: 'e', v: ['a', 'b'] },
  { k: 'weird', t: 'h', v: [['__proto__', 'x'], ['constructor', 'y']] },
];

test('encodePart/decodePart: круг для всех типов, юникода, пустой строки и поля __proto__', () => {
  const buf = B.encodePart({ snap: SNAP, n: 3, recs: SAMPLE, at: 1700000000000 });
  const r = B.decodePart(buf, { snap: SNAP, n: 3 });
  assert.deepEqual(r.recs, SAMPLE);
  assert.deepEqual([r.meta.v, r.meta.snap, r.meta.n, r.meta.at, r.meta.count, r.meta.prefix], [1, SNAP, 3, 1700000000000, 5, '']);
  assert.equal({}.x, undefined, 'прототип не тронут');
  assert.equal(buf.includes(Buffer.from('nick:anna')), false, 'имена ключей в файле не видны');
  assert.equal(B.decodePart(B.encodePart({ snap: SNAP, n: 0, recs: [] }), { snap: SNAP, n: 0 }).recs.length, 0);
});

test('decodePart: часть другой копии или другого номера, другой ключ, подмена — отказ', () => {
  const buf = B.encodePart({ snap: SNAP, n: 1, recs: SAMPLE });
  assert.throws(() => B.decodePart(buf, { snap: SNAP, n: 2 }), (e) => e.kind === 'tamper', 'части переставлены');
  assert.throws(() => B.decodePart(buf, { snap: 'snap-other-0001', n: 1 }), (e) => e.kind === 'tamper', 'другая копия');
  process.env.BACKUP_KEY = KEY2;
  assert.throws(() => B.decodePart(buf, { snap: SNAP, n: 1 }), (e) => e.kind === 'key');
  process.env.BACKUP_KEY = KEY1;
  assert.throws(() => B.encodePart({ snap: 'Плохо', n: 0, recs: [] }), (e) => e.kind === 'format');
  assert.throws(() => B.encodePart({ snap: SNAP, n: -1, recs: [] }), (e) => e.kind === 'format');
});

test('decodePart: зашифрованное, но неправильное содержимое отвергается (версия, число записей, форма записи, не gzip, бомба)', () => {
  const seal = (text) => B.seal(gzipSync(Buffer.from(text)), SNAP + '|0');
  const meta = (o) => JSON.stringify({ v: 1, snap: SNAP, n: 0, at: 1, prefix: '', count: 0, ...o });
  const dec = (buf) => B.decodePart(buf, { snap: SNAP, n: 0 });
  assert.equal(dec(seal(meta({}))).recs.length, 0);
  assert.throws(() => dec(seal(meta({ v: 2 }))), (e) => e.kind === 'format');
  assert.throws(() => dec(seal(meta({ count: 1 }))), (e) => e.kind === 'format', 'записей меньше заявленного');
  assert.throws(() => dec(seal(meta({ snap: 'snap-other-0001' }))), (e) => e.kind === 'tamper');
  for (const bad of ['{"k":"a","t":"x","v":"1"}', '{"k":"a","t":"s","v":5}', '{"k":"","t":"s","v":"1"}', '{"k":"a","t":"h","v":[]}',
    '{"k":"a","t":"h","v":[["f"]]}', '{"k":"a","t":"e","v":[1]}', '{"k":"a","t":"s","v":"1","ttl":0}', '{"k":"a","t":"s","v":"1","ttl":1.5}', 'не json'])
    assert.throws(() => dec(seal(meta({ count: 1 }) + '\n' + bad)), (e) => e.kind === 'format', bad);
  assert.throws(() => dec(B.seal(Buffer.from('это не gzip'), SNAP + '|0')), (e) => e.kind === 'format');
  assert.throws(() => dec(B.seal(gzipSync(Buffer.alloc(B.MAX_PLAIN + 1)), SNAP + '|0')), (e) => e.kind === 'format' && /слишком велика/.test(e.message), 'распаковка не больше MAX_PLAIN');
});

/* ---------- обход ключей ---------- */
test('readBatch: все типы с TTL, по одному ключу за шаг; курсор доходит до конца', async () => {
  await seed();
  const { recs, st } = await readAll(1);
  const m = byKey(recs);
  assert.deepEqual(Object.keys(m).sort(), ['agent:' + hex(1), 'doc:' + hex(1), 'empty:str', 'misc:ttl', 'nick:anna', 'tgs']);
  assert.deepEqual(m['doc:' + hex(1)], { k: 'doc:' + hex(1), t: 'h', v: [['d', '{"months":{"2026-10":[]}}'], ['v', '3']] });
  assert.deepEqual(m['agent:' + hex(1)].v[0], ['d', 'Привет, мир\nвторая строка']);
  assert.deepEqual(m.tgs, { k: 'tgs', t: 'e', v: [hex(1), hex(2)] });
  assert.equal(m['empty:str'].v, '');
  assert.equal(m['empty:str'].ttl, undefined);
  assert.ok(m['misc:ttl'].ttl > 590000 && m['misc:ttl'].ttl <= 600000, 'TTL неизвестного вида сохранён');
  assert.equal(m['nick:anna'].ttl, undefined);
  assert.equal(st.copied, 6);
  assert.equal(st.temp, 2, 'rl и tgt не копируются, но посчитаны');
  assert.equal(recs.every(B.validRec), true);
});

/* ---------- расход команд (часть 2 сокращения команд Redis) ---------- */
// Все известные виды ключей проекта, по одному ключу каждого, плюс временные.
async function seedKnown() {
  await db.cmd('SET', 'acc:' + hex(1), '{"nick":"anna"}');
  await db.cmd('SET', 'nick:anna', hex(1));
  await db.cmd('SET', 'tg:' + hex(1), '{"tid":"5","chat":"5"}');
  await db.cmd('SET', 'tgu:5', hex(1));
  await db.cmd('SET', 'users', '1');
  for (const kind of ['doc', 'rem', 'agent', 'wifi', 'bot']) await db.cmd('HSET', kind + ':' + hex(1), 'd', '{}', 'v', '1');
  await db.cmd('SADD', 'tgs', hex(1));
  await db.cmd('SET', 'rl:li:ip:abc', '2', 'PX', 900000);
  await db.cmd('SET', 'tgt:abcd', hex(1), 'PX', 600000);
  await db.cmd('SET', 'tgp:' + hex(1), 'abcd', 'PX', 600000);
}
const names = (log) => log.map((c) => c.split(' ')[0]);

test('известные виды ключей читаются одной командой на ключ: ни TYPE, ни PTTL; команд столько же, сколько ключей, плюс SCAN', async () => {
  await seedKnown();
  __cmdLog(true);
  const { recs, st } = await readAll(1000);
  const log = __cmdLog(true);
  assert.equal(recs.length, 11, 'все 11 известных ключей скопированы');
  assert.equal(st.copied, 11);
  assert.deepEqual([st.temp, st.gone, st.changed, st.foreign], [3, 0, 0, 0], 'rl, tgt, tgp считаются, но не копируются');
  assert.equal(names(log).includes('TYPE') || names(log).includes('PTTL'), false, 'TYPE/PTTL для известных ключей не нужны');
  const c = (n) => names(log).filter((x) => x === n).length;
  assert.deepEqual([c('SCAN'), c('GET'), c('HGETALL'), c('SMEMBERS')], [1, 5, 5, 1]);
  assert.equal(log.length, 1 + 11, 'SCAN + по команде на ключ');
  assert.equal(recs.some((r) => /^(rl|tgt|tgp)/.test(r.k)), false);
  assert.equal(recs.every(B.validRec), true);
});

test('известные ключи: типы и значения те же, что при чтении через TYPE и PTTL (формат копии не изменился)', async () => {
  await seedKnown();
  const fast = byKey((await readAll(1000)).recs);
  const known = [...B.KNOWN];
  B.KNOWN.clear(); // «прежний путь»: всё неизвестное читается через TYPE и PTTL
  let slow;
  try { slow = byKey((await readAll(1000)).recs); } finally { for (const [k, v] of known) B.KNOWN.set(k, v); }
  for (const k of Object.keys(slow).filter((x) => !/^(rl|tgt|tgp)/.test(x))) assert.deepEqual(fast[k], slow[k], k);
  assert.deepEqual(Object.keys(fast).sort(), Object.keys(slow).filter((x) => !/^(rl|tgt|tgp)/.test(x)).sort());
});

test('известный ключ другого типа: читается прежним путём (TYPE, PTTL), попадает в копию с верным типом и сроком, не считается changed', async () => {
  await seedKnown();
  await db.cmd('DEL', 'doc:' + hex(1));
  await db.cmd('SET', 'doc:' + hex(1), 'это строка, а не хэш', 'PX', 600000); // вид doc, но тип string и срок жизни
  await db.cmd('DEL', 'tgs');
  await db.cmd('HSET', 'tgs', 'f', 'x'); // вид tgs, но тип hash
  __cmdLog(true);
  const { recs, st } = await readAll(1000);
  const log = names(__cmdLog(true));
  const m = byKey(recs);
  assert.deepEqual(m['doc:' + hex(1)].t, 's');
  assert.equal(m['doc:' + hex(1)].v, 'это строка, а не хэш');
  assert.ok(m['doc:' + hex(1)].ttl > 590000, 'срок жизни сохранён: ключ прошёл через PTTL');
  assert.deepEqual(m.tgs, { k: 'tgs', t: 'h', v: [['f', 'x']] });
  assert.equal(st.copied, 11);
  assert.deepEqual([st.changed, st.gone], [0, 0]);
  assert.equal(log.filter((x) => x === 'TYPE').length, 2, 'TYPE только у двух ключей с неверным типом');
  assert.equal(log.filter((x) => x === 'PTTL').length, 2);
  assert.equal(recs.every(B.validRec), true);
});

test('известный ключ пропал между SCAN и чтением: gone; пустой хэш и пустое множество не дают записи', async () => {
  await seedKnown();
  __after('SCAN', () => { __drop('nick:anna'); __drop('tgs'); });
  const { recs, st } = await readAll(1000);
  assert.equal(recs.some((r) => r.k === 'nick:anna' || r.k === 'tgs'), false);
  assert.equal(st.gone, 2);
  assert.equal(st.copied, 9);
});

test('вид ключа сравнивается целиком: «docx:», «tgsx», «constructor:» и «__proto__:» — неизвестные виды, читаются через TYPE и PTTL', async () => {
  await db.cmd('HSET', 'docx:1', 'a', 'b');
  await db.cmd('SET', 'tgsx', '1', 'PX', 600000);
  await db.cmd('SET', 'constructor:1', '2');
  await db.cmd('SET', '__proto__:1', '3');
  await db.cmd('SET', 'rlx:1', '4');
  __cmdLog(true);
  const { recs, st } = await readAll(1000);
  const log = names(__cmdLog(true));
  assert.deepEqual(recs.map((r) => r.k).sort(), ['__proto__:1', 'constructor:1', 'docx:1', 'rlx:1', 'tgsx']);
  assert.equal(st.temp, 0);
  assert.equal(log.filter((x) => x === 'TYPE').length, 5);
  assert.ok(byKey(recs).tgsx.ttl > 0, 'срок жизни неизвестного вида сохранён');
});

test('с префиксом «t:» виды определяются по имени без префикса: временные не копируются, известные читаются без TYPE', async () => {
  process.env.DB_PREFIX = 't:';
  await db.cmd('SET', db.key('nick', 'bob'), 'x');
  await db.cmd('SET', db.key('rl', 'a'), '1', 'PX', 900000);
  await db.cmd('HSET', db.key('doc', hex(2)), 'd', '{}', 'v', '1');
  __cmdLog(true);
  const { recs, st } = await readAll(1000);
  assert.deepEqual(recs.map((r) => r.k), ['doc:' + hex(2), 'nick:bob'], 'записи отсортированы, без префикса');
  assert.equal(st.temp, 1);
  assert.equal(names(__cmdLog(true)).includes('TYPE'), false);
});

test('копия прежнего вида читается: запись с ttl и временные ключи в части проходят decodePart и restoreCmds', () => {
  const old = [{ k: 'tgt:abcd', t: 's', v: hex(1), ttl: 590000 }, { k: 'rl:ip:1', t: 's', v: '3', ttl: 800000 }, { k: 'nick:anna', t: 's', v: hex(1) }];
  const back = B.decodePart(B.encodePart({ snap: SNAP, n: 0, recs: old }), { snap: SNAP, n: 0 }).recs;
  assert.deepEqual(back, old);
  assert.deepEqual(B.restoreCmds(back[0], 't')[2], ['PEXPIRE', 't:tgt:abcd', 590000]);
});

test('readBatch: результат не зависит от размера шага; повторы ключей допустимы', async () => {
  await seed();
  const norm = (a) => [...new Map(a.map((r) => [r.k, JSON.stringify({ ...r, ttl: r.ttl ? 1 : 0 })])).values()].sort();
  const a = await readAll(1), b = await readAll(1000);
  assert.deepEqual(norm(a.recs), norm(b.recs));
});

test('readBatch: пустая база и пустой префикс дают done сразу', async () => {
  const r = await B.readBatch('0');
  assert.deepEqual([r.recs.length, r.done, r.cursor], [0, true, '0']);
});

test('боевой префикс (пустой): ключи тестового проекта «t:» и selftest не попадают в копию', async () => {
  await seed();
  await db.cmd('SET', 't:nick:bob', 'x');
  await db.cmd('HSET', 't:doc:' + hex(9), 'd', '{}', 'v', '1');
  await db.cmd('SET', 'selftest123:x', '1');
  const { recs, st } = await readAll(2);
  assert.equal(recs.some((r) => r.k.startsWith('t:') || r.k.startsWith('selftest')), false);
  assert.equal(recs.length, 6);
  assert.equal(st.foreign, 3);
});

test('префикс «t:»: копируется только он, в записях ключи без префикса, в заголовке префикс; префикс со спецсимволами не раскрывается', async () => {
  await seed();
  process.env.DB_PREFIX = 't:';
  await db.cmd('SET', db.key('nick', 'bob'), 'x');
  await db.cmd('SET', 'tx:nick:zed', 'y'); // подошёл бы под «t*»
  const { recs } = await readAll(2);
  assert.deepEqual(recs.map((r) => r.k), ['nick:bob']);
  const meta = B.decodePart(B.encodePart({ snap: SNAP, n: 0, recs }), { snap: SNAP, n: 0 }).meta;
  assert.equal(meta.prefix, 't:');
  process.env.DB_PREFIX = 'p[1]*:';
  await db.cmd('SET', db.key('nick', 'a'), '1');
  await db.cmd('SET', 'p1x:nick:b', '2');
  assert.deepEqual((await readAll(5)).recs.map((r) => r.k), ['nick:a']);
});

test('типы, которых код не использует (list, zset), пропускаются и считаются; пропавший ключ считается gone', async () => {
  await seed();
  __putOther('queue:1', 'list');
  __putOther('rank:1', 'zset');
  await db.cmd('SET', 'short', '1', 'PX', 1);
  await new Promise((r) => setTimeout(r, 5));
  const { recs, st } = await readAll(100);
  assert.equal(recs.some((r) => r.k === 'queue:1' || r.k === 'rank:1' || r.k === 'short'), false);
  assert.deepEqual(st.other, { list: 1, zset: 1 });
  assert.equal(recs.length, 6);
});

test('ключ пропал между SCAN и чтением: считается gone, остальные копируются', async () => {
  await seed();
  __after('SCAN', () => __drop('nick:anna'));
  const { recs, st } = await readAll(1000);
  assert.equal(recs.some((r) => r.k === 'nick:anna'), false);
  assert.equal(st.gone, 1);
  assert.deepEqual(st.other, {});
  assert.equal(recs.length, 5);
  const g = await B.readRecs(['no:such'], ['string'], [-1]);
  assert.deepEqual(g.st, { copied: 0, gone: 1, changed: 0 });
});

test('readRecs: тип сменился между TYPE и чтением — ключ считается changed, остальные читаются', async () => {
  await db.cmd('SET', 'a:str', 'v');
  await db.cmd('HSET', 'b:hash', 'f', 'x');
  const r = await B.readRecs(['a:str', 'b:hash'], ['string', 'string'], [-1, -1]); // у b:hash тип назван неверно
  assert.deepEqual(r.recs, [{ k: 'a:str', t: 's', v: 'v' }]);
  assert.deepEqual(r.st, { copied: 1, gone: 0, changed: 1 });
});

test('сбой Redis при обходе — ошибка наружу, а не пустая копия', async () => {
  await seed();
  const { __fail } = await import('./redis.mjs');
  __fail('network');
  await assert.rejects(B.readBatch('0'), (e) => e.name === 'DbError');
  __fail(null);
});

/* ---------- восстановление ---------- */
test('круг: база → копия (части, шифр) → стирание → восстановление даёт то же самое', async () => {
  await seed();
  const before = Object.fromEntries(Object.entries(await dump('')).filter(([k]) => !isTemp(k))); // временные в копию не входят
  const { recs } = await readAll(2);
  const bufs = [recs.slice(0, 3), recs.slice(3)].map((part, n) => B.encodePart({ snap: SNAP, n, recs: part }));
  __reset();
  await db.cmd('SET', 'doc:' + hex(1), 'старое значение другого типа'); // мусор того же ключа должен быть стёрт
  const back = bufs.flatMap((b, n) => B.decodePart(b, { snap: SNAP, n }).recs);
  for (const r of back) await db.pipe(B.restoreCmds(r));
  const after = await dump('');
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const k of Object.keys(before)) {
    assert.equal(after[k].type, before[k].type, k);
    assert.deepEqual(after[k].v, before[k].v, k);
    if (before[k].ttl > 0) assert.ok(Math.abs(after[k].ttl - before[k].ttl) < 2000, 'TTL ' + k);
    else assert.equal(after[k].ttl, -1, k);
  }
});

test('восстановление в другой префикс («t:»): боевые ключи не тронуты, лишнее в приёмнике стёрто только у восстановленных ключей', async () => {
  await seed();
  const { recs } = await readAll(10);
  await db.cmd('HSET', 't:doc:' + hex(1), 'лишнее', 'поле', 'd', 'старое', 'v', '9');
  await db.cmd('SET', 't:other', 'остаётся');
  const prod = await dump('');
  for (const r of recs) await db.pipe(B.restoreCmds(r, 't'));
  assert.deepEqual(__raw('t:doc:' + hex(1)), { d: '{"months":{"2026-10":[]}}', v: '3' }, 'лишнее поле стёрто');
  assert.equal(__raw('t:other'), 'остаётся');
  assert.equal(__raw('t:nick:anna'), hex(1));
  for (const [k, v] of Object.entries(prod)) if (!k.startsWith('t:')) assert.deepEqual(await db.cmd('TYPE', k), v.type, 'боевой ключ ' + k + ' цел');
});

test('restoreCmds: испорченная запись отвергается; префикс без двоеточия нормализуется', () => {
  assert.throws(() => B.restoreCmds({ k: 'a', t: 'q', v: '1' }), (e) => e.kind === 'format');
  assert.deepEqual(B.restoreCmds({ k: 'a', t: 's', v: '1', ttl: 50 }, 'x')[1], ['SET', 'x:a', '1']);
  assert.deepEqual(B.restoreCmds({ k: 'a', t: 's', v: '1', ttl: 50 }, 'x')[2], ['PEXPIRE', 'x:a', 50]);
  assert.deepEqual(B.restoreCmds({ k: 'h', t: 'h', v: [['f', '1'], ['g', '2']] }, '')[1], ['HSET', 'h', 'f', '1', 'g', '2']);
});

test('recSize: размер растёт с записью', () => {
  assert.ok(B.recSize({ k: 'a', t: 's', v: 'x'.repeat(1000) }) > 1000);
});
