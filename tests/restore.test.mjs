// Этап 4.4: скрипт восстановления scripts/restore-backup.mjs (список, проверка, сухой прогон, применение, проверка восстановления «drill», сверка).
// Заглушки Redis и Blob. Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __keys, __raw, __fail } from './redis.mjs';
import { __reset, __keys as blobKeys, __read, __write } from './blob.mjs';
import { setEnv } from './helpers.mjs';

setEnv();
const db = await import('../api/_db.js');
const B = await import('../api/_backup.js');
const R = await import('../scripts/restore-backup.mjs');

const KEY1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';
const KEY2 = '00ffeeddccbbaa99887766554433221100f0e0d0c0b0a09080706050403020a1';
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

let envPrefix;
beforeEach(() => { __reset(); setEnv(); process.env.BACKUP_KEY = KEY1; envPrefix = process.env.DB_PREFIX; });

const hex = (n) => n.toString(16).padStart(32, '0');
async function seed(n = 6) {
  for (let i = 1; i <= n; i++) {
    await db.cmd('HSET', 'doc:' + hex(i), 'd', JSON.stringify({ months: { '2026-10': [{ s: 'Магазин ' + i }] } }), 'v', String(i));
    await db.cmd('SET', 'nick:user' + i, hex(i));
  }
  await db.cmd('SADD', 'tgs', hex(1), hex(2));
  await db.cmd('SET', 'tgt:abcd', hex(1), 'PX', 600000);
  await db.cmd('SET', 'rl:ip:1.2.3.4', '3', 'PX', 900000);
}
const dumpAll = () => JSON.stringify(__keys().map((k) => [k, __raw(k)]));
async function makeBackup(at = T0) { const r = await B.runBackup({ now: () => at }); assert.equal(r.state, 'done'); return r; }
function mkIo(over = {}) {
  const lines = [], asked = [];
  return { io: { log: (s) => lines.push(s), confirm: async (q, w) => { asked.push([q, w]); return true; }, ...over }, lines, asked, text: () => lines.join('\n') };
}
const run = (o, io) => R.run(o, io);

/* ---------- чтение ---------- */
test('--list: копии с датой, числом ключей и частей; неполная и нечитаемая названы; Redis не нужен', async () => {
  await seed();
  const a = await makeBackup(T0);
  const b = await makeBackup(T0 + 864e5);
  await db.cmd('SET', 'zzz', '1'); // чтобы не пусто
  const m = mkIo();
  const saved = [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN];
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  try { await run({ list: true }, m.io); } finally { [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN] = saved; }
  assert.match(m.text(), /Копий в хранилище: 2/);
  assert.ok(m.text().indexOf(b.snap) < m.text().indexOf(a.snap), 'новые первыми');
  assert.match(m.text(), /2026-10-06 12:00:00 UTC, ключей 15, частей 1/);
  process.env.BACKUP_KEY = KEY2;
  const m2 = mkIo();
  await run({ list: true }, m2.io);
  assert.match(m2.text(), /НЕ ЧИТАЕТСЯ \(key\)/);
});

test('--verify: хорошая копия проходит; испорченная часть даёт проблемы и ok:false', async () => {
  await seed();
  const a = await makeBackup();
  const m = mkIo();
  const r = await run({ verify: true }, m.io);
  assert.equal(r.ok, true);
  assert.match(m.text(), new RegExp('Копия ' + a.snap + ': частей 1, ключей 15, проверка пройдена'));
  const p = 'backup/' + a.snap + '/p0.bin';
  const c = Buffer.from(__read(p)); c[c.length - 1] ^= 1; __write(p, c);
  const m2 = mkIo();
  const r2 = await run({ verify: true }, m2.io);
  assert.equal(r2.ok, false);
  assert.match(m2.text(), /ПРОБЛЕМЫ: 1/);
  assert.match(m2.text(), /часть 0/);
});

/* ---------- сухой прогон ---------- */
test('сухой прогон по умолчанию: считает создаваемые и перезаписываемые, пропускает rl и tgt, ничего не пишет', async () => {
  await seed();
  await makeBackup();
  await db.cmd('DEL', 'doc:' + hex(1), 'doc:' + hex(2)); // два ключа пропали, остальные 13 существуют
  const before = dumpAll();
  const m = mkIo();
  const r = await run({}, m.io);
  assert.equal(dumpAll(), before);
  assert.equal(r.mode, 'dry');
  assert.deepEqual([r.plan.total, r.plan.create, r.plan.overwrite, r.plan.skipped], [13, 2, 11, 2]);
  assert.match(m.text(), /сухой прогон/);
  assert.match(m.text(), /создать 2, перезаписать 11; пропущено временных 2 \(rl 1, tgt 1\)/);
  assert.match(m.text(), /Куда: префикс «\(пусто: боевая база\)»/);
  assert.equal(m.asked.length, 0);
  assert.doesNotMatch(m.text(), /Магазин|user1|[0-9a-f]{32}/);
});

test('--all включает временные ключи в план', async () => {
  await seed();
  await makeBackup();
  const r = await run({ all: true }, mkIo().io);
  assert.deepEqual([r.plan.total, r.plan.skipped], [15, 0]);
  const r2 = await run({ skip: ['doc'] }, mkIo().io);
  assert.equal(r2.plan.kinds.doc, undefined);
  assert.equal(r2.plan.skipped, 6);
});

/* ---------- применение ---------- */
test('--apply в боевую базу: нужно ввести RESTORE PROD; неверный ответ ничего не меняет; после записи сверка без расхождений', async () => {
  await seed();
  await makeBackup();
  const original = dumpAll();
  for (const k of __keys()) await db.cmd('DEL', k); // «авария»: база пуста
  const bad = mkIo({ confirm: async (q, w) => { bad.asked.push([q, w]); return false; } });
  const r0 = await run({ apply: true }, bad.io);
  assert.equal(r0.mode, 'cancelled');
  assert.equal(__keys().length, 0);
  assert.equal(bad.asked[0][1], 'RESTORE PROD');
  assert.match(bad.asked[0][0], /БОЕВУЮ БАЗУ/);
  const m = mkIo();
  const r = await run({ apply: true }, m.io);
  assert.equal(r.ok, true);
  assert.deepEqual([r.restored, r.mismatches], [13, 0]);
  assert.match(m.text(), /Готово: восстановлено 13 ключей, все совпали с копией/);
  const got = Object.fromEntries(__keys().map((k) => [k, JSON.stringify(__raw(k))]));
  const want = Object.fromEntries(JSON.parse(original).filter(([k]) => !k.startsWith('rl:') && !k.startsWith('tgt:')).map(([k, v]) => [k, JSON.stringify(v)]));
  assert.deepEqual(got, want);
  assert.equal(__keys().some((k) => k.startsWith('rl:') || k.startsWith('tgt:')), false, 'временные по умолчанию не возвращаются');
});

test('перезапись: устаревшее поле хэша и ключ другого типа стираются, ключи не из копии остаются', async () => {
  await seed();
  await makeBackup();
  await db.cmd('HSET', 'doc:' + hex(1), 'лишнее', 'поле', 'd', 'испорчено', 'v', '99');
  await db.cmd('SET', 'doc:' + hex(2), 'теперь строка');
  await db.cmd('SET', 'новый:ключ', 'остаётся');
  const r = await run({ apply: true, yes: true }, mkIo().io);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(__raw('doc:' + hex(1))).sort(), ['d', 'v']);
  assert.equal(__raw('doc:' + hex(1)).v, '1');
  assert.equal(typeof __raw('doc:' + hex(2)), 'object', 'ключ снова хэш');
  assert.equal(__raw('новый:ключ'), 'остаётся');
});

test('--to=t: восстановление в другой префикс, боевые ключи не тронуты; подтверждение RESTORE', async () => {
  await seed();
  await makeBackup();
  await db.cmd('HSET', 'doc:' + hex(1), 'd', 'боевое изменено', 'v', '9');
  const prod = JSON.stringify(__raw('doc:' + hex(1)));
  const m = mkIo();
  const r = await run({ apply: true, to: 't' }, m.io);
  assert.equal(r.ok, true);
  assert.equal(m.asked[0][1], 'RESTORE');
  assert.match(m.asked[0][0], /в префикс «t:»/);
  assert.equal(JSON.stringify(__raw('doc:' + hex(1))), prod);
  assert.equal(__raw('t:doc:' + hex(1)).v, '1');
  assert.equal(__raw('t:nick:user3'), hex(3));
  assert.equal(process.env.DB_PREFIX, envPrefix, 'DB_PREFIX процесса возвращён');
});

test('--all: временные ключи возвращаются со сроком жизни; сверка принимает срок', async () => {
  await seed();
  await makeBackup();
  for (const k of __keys()) await db.cmd('DEL', k);
  const r = await run({ apply: true, yes: true, all: true }, mkIo().io);
  assert.deepEqual([r.ok, r.restored, r.mismatches], [true, 15, 0]);
  const ttl = await db.cmd('PTTL', 'tgt:abcd');
  assert.ok(ttl > 0 && ttl <= 600000);
});

/* ---------- защита ---------- */
test('повреждённая копия не применяется: ни одной записи в Redis', async () => {
  await seed();
  const a = await makeBackup();
  const p = 'backup/' + a.snap + '/p0.bin';
  const c = Buffer.from(__read(p)); c[40] ^= 1; __write(p, c);
  const before = dumpAll();
  const m = mkIo();
  for (const o of [{ apply: true, yes: true }, { drill: true }, {}]) {
    const r = await run(o, mkIo({ log: m.io.log }).io);
    assert.deepEqual([r.ok, r.mode], [false, 'refused']);
  }
  assert.equal(dumpAll(), before);
  assert.match(m.text(), /повреждена, восстановление остановлено, ничего не записано/);
});

test('другой BACKUP_KEY и отсутствие копий: понятная ошибка, ничего не записано', async () => {
  await seed();
  await makeBackup();
  const before = dumpAll();
  process.env.BACKUP_KEY = KEY2;
  await assert.rejects(run({ apply: true, yes: true }, mkIo().io), /Нет ни одной полной читаемой копии/);
  await assert.rejects(run({ apply: true, yes: true, snap: 'x'.repeat(4) }, mkIo().io), (e) => e.kind === 'missing' || e.kind === 'key' || /не найдена/.test(e.message));
  assert.equal(dumpAll(), before);
  __reset(); setEnv(); process.env.BACKUP_KEY = KEY1;
  await assert.rejects(run({}, mkIo().io), /Нет ни одной полной читаемой копии/);
});

test('--snap выбирает конкретную копию, а не новейшую', async () => {
  await seed();
  const a = await makeBackup(T0);
  await db.cmd('SET', 'nick:новый', 'позже');
  await makeBackup(T0 + 864e5);
  const r = await run({ snap: a.snap }, mkIo().io);
  assert.equal(r.snap, a.snap);
  assert.equal(r.plan.total, 13);
  const r2 = await run({}, mkIo().io);
  assert.equal(r2.plan.total, 14);
});

test('сбой записи в Redis посреди восстановления: ошибка наружу, «Готово» не пишется', async () => {
  await seed();
  await makeBackup();
  const m = mkIo();
  __fail('write');
  await assert.rejects(run({ apply: true, yes: true }, m.io));
  __fail(null);
  assert.doesNotMatch(m.text(), /Готово/);
});

/* ---------- проверка восстановления ---------- */
test('--drill: копия разворачивается в одноразовый префикс, сверяется и удаляется; боевая база не меняется; подтверждение не нужно', async () => {
  await seed(20);
  await makeBackup();
  const before = dumpAll();
  const m = mkIo();
  const r = await run({ drill: true }, m.io);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'drill');
  assert.deepEqual([r.mismatches, r.restored], [0, 41]);
  assert.ok(r.wiped >= 41 - r.expired);
  assert.equal(dumpAll(), before, 'после проверки Redis ровно как до неё');
  assert.equal(m.asked.length, 0);
  assert.match(m.text(), /Проверка восстановления пройдена: копия \S+ разворачивается, 41 ключей совпали с копией, боевая база не затронута/);
  assert.equal(process.env.DB_PREFIX, envPrefix);
});

test('--drill на базе с префиксом: чужие ключи не тронуты, одноразовый префикс другой при каждом запуске', async () => {
  process.env.DB_PREFIX = 'p:';
  await db.cmd('HSET', db.key('doc', hex(1)), 'd', '{}', 'v', '1');
  await db.cmd('SET', 'p:doc:x', '1');
  await db.cmd('SET', 'чужой', 'не мой');
  await makeBackup();
  const before = dumpAll();
  const a = await run({ drill: true }, mkIo().io);
  const b = await run({ drill: true }, mkIo().io);
  assert.deepEqual([a.ok, b.ok], [true, true]);
  assert.notEqual(a.to, b.to, 'префикс проверки одноразовый и уникальный');
  assert.match(a.to, /^drill[0-9a-z]+:$/);
  assert.equal(dumpAll(), before);
  assert.equal(process.env.DB_PREFIX, 'p:');
});

test('--drill: если одноразовый префикс уже занят, проверка отказывается и ничего не удаляет', async (t) => {
  await seed();
  await makeBackup();
  const fixed = Date.now();
  t.mock.method(Date, 'now', () => fixed);
  const stamp = fixed.toString(36);
  await db.cmd('SET', 'drill' + stamp + ':чужой', 'не трогать');
  const before = dumpAll();
  await assert.rejects(run({ drill: true }, mkIo().io), /уже занят/);
  assert.equal(dumpAll(), before);
  assert.equal(process.env.DB_PREFIX, envPrefix);
});

/* ---------- сверка ---------- */
test('compareRecs находит расхождения: другое значение, другой тип, нет ключа, лишний срок; просроченный временный не ошибка', async () => {
  const recs = [
    { k: 'a', t: 's', v: '1' },
    { k: 'b', t: 'h', v: [['f', '1'], ['g', '2']] },
    { k: 'c', t: 'e', v: ['x', 'y'] },
    { k: 'd', t: 's', v: 'с сроком', ttl: 500000 },
    { k: 'e', t: 's', v: 'просрочен', ttl: 1000 },
  ];
  for (const r of recs.slice(0, 4)) for (const c of B.restoreCmds(r, '')) await db.cmd(...c);
  const ok = await R.compareRecs(recs, 5000);
  assert.deepEqual(ok, { checked: 5, mismatches: 0, expired: 1 });
  await db.cmd('SET', 'a', '2'); // значение
  await db.cmd('DEL', 'b'); await db.cmd('SET', 'b', 'строка'); // тип
  await db.cmd('SREM', 'c', 'y'); // состав множества
  await db.cmd('PERSIST', 'd').catch(() => {});
  const bad = await R.compareRecs(recs.slice(0, 3), 0);
  assert.equal(bad.mismatches, 3);
  await db.cmd('DEL', 'a');
  assert.equal((await R.compareRecs([recs[0]], 0)).mismatches, 1, 'нет ключа');
});

test('сверка порядок-независима: хэш и множество читаются в другом порядке', async () => {
  const rec = { k: 'h', t: 'h', v: [['b', '2'], ['a', '1']] };
  for (const c of B.restoreCmds(rec, '')) await db.cmd(...c);
  assert.equal((await R.compareRecs([rec], 0)).mismatches, 0);
});

/* ---------- вывод и разбор флагов ---------- */
test('в журнале нет ключей шифрования, адресов Redis, токенов, имён ключей и содержимого', async () => {
  await seed();
  await makeBackup();
  process.env.BLOB_READ_WRITE_TOKEN = 'blob-secret-token';
  const m = mkIo();
  await run({ list: true }, m.io);
  await run({}, m.io);
  await run({ drill: true }, m.io);
  await run({ verify: true }, m.io);
  const t = m.text();
  for (const secret of [KEY1, process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN, 'blob-secret-token', 'Магазин', 'nick:user', hex(1)]) assert.ok(!t.includes(secret), 'в журнале: ' + secret.slice(0, 12));
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

test('разбор флагов: умолчания, значения, несовместимые сочетания, неверные значения', () => {
  assert.deepEqual(R.parseArgs([]), { list: false, verify: false, apply: false, yes: false, all: false, drill: false, help: false, snap: undefined, to: undefined, skip: undefined });
  const o = R.parseArgs(['--apply', '--to=t', '--skip=rl,tgt', '--snap=20261005t180000-ab12']);
  assert.deepEqual([o.apply, o.to, o.skip, o.snap], [true, 't', ['rl', 'tgt'], '20261005t180000-ab12']);
  assert.equal(R.parseArgs(['--to=']).to, '');
  for (const bad of [['--list', '--verify'], ['--drill', '--apply'], ['--drill', '--to=t'], ['--verify', '--apply'], ['--list', '--to=t'], ['--all', '--skip=rl'], ['--snap=../x'], ['--to=a b'], ['--skip=a;b'], ['--wipe']]) assert.throws(() => R.parseArgs(bad), Error, bad.join(' '));
});
