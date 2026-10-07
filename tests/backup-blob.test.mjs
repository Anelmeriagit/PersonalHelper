// Этап 4.2: хранение резервных копий в Blob (api/_backup.js): части, манифест, ход и замок, ротация 7 копий, проверка копии.
// Заглушки Redis и Blob из tests/. Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __keys, __raw } from './redis.mjs';
import { __reset, __keys as blobKeys, __read, __write, __failPutOn, __puts, put as blobPut } from './blob.mjs';
import { setEnv } from './helpers.mjs';

setEnv();
const db = await import('../api/_db.js');
const B = await import('../api/_backup.js');

const KEY1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';
const KEY2 = '00ffeeddccbbaa99887766554433221100f0e0d0c0b0a09080706050403020a1';
const PROGRESS = 'backup/progress.bin';
const T0 = Date.UTC(2026, 9, 5, 18, 0, 0);
const DAY = 864e5;

beforeEach(() => { __reset(); setEnv(); process.env.BACKUP_KEY = KEY1; });

const hex = (n) => n.toString(16).padStart(32, '0');
async function seed(n = 5) {
  for (let i = 1; i <= n; i++) {
    await db.cmd('HSET', 'doc:' + hex(i), 'd', JSON.stringify({ months: { '2026-10': [{ shop: 'Секретный магазин ' + i }] } }), 'v', String(i));
    await db.cmd('SET', 'nick:user' + i, hex(i));
  }
  await db.cmd('SADD', 'tgs', hex(1), hex(2));
  await db.cmd('SET', 'tgt:abcd', hex(1), 'PX', 600000);
}
// Часы для тестов: now() отдаёт заданное время, advance сдвигает.
function clock(start = T0) { let t = start; const f = () => t; f.advance = (ms) => { t += ms; }; f.set = (v) => { t = v; }; return f; }
const redisState = () => JSON.stringify(__keys().map((k) => [k, __raw(k)]));
const snapsIn = () => [...new Set(blobKeys().map((k) => /^backup\/([^/]+)\//.exec(k)).filter(Boolean).map((m) => m[1]))];
// Временные ключи (tgt:, rl:, tgp:) в копию не попадают.
const dbKeys = () => __keys().filter((k) => !k.startsWith('t:') && !/^(tgt|rl|tgp):/.test(k)).sort();

async function allRecs(snap) {
  const man = await B.readManifest(snap);
  const out = [];
  for (const p of man.parts) out.push(...(await B.readPart(snap, man, p.n)).recs);
  return out;
}

test('копия маленькой базы: одна часть, манифест, ход убран, Redis не тронут, в хранилище только шифртекст', async () => {
  await seed();
  const before = redisState();
  const now = clock();
  const r = await B.runBackup({ now });
  assert.equal(r.state, 'done');
  assert.match(r.snap, /^20261005t180000-[0-9a-f]{4}$/);
  assert.deepEqual([r.parts, r.keys, r.pruned], [1, 11, 0]);
  assert.equal(redisState(), before, 'копия ничего не пишет в Redis');
  assert.deepEqual(blobKeys(), ['backup/' + r.snap + '/manifest.bin', 'backup/' + r.snap + '/p0.bin']);
  for (const k of blobKeys()) {
    const b = __read(k);
    assert.equal(b.subarray(0, 4).toString(), 'PHB1', k);
    for (const secret of ['Секретный магазин', 'nick:user', 'doc:', r.snap]) assert.equal(b.includes(Buffer.from(secret)), false, k + ' содержит ' + secret);
  }
  assert.deepEqual((await allRecs(r.snap)).map((x) => x.k).sort(), dbKeys());
  const v = await B.verifyBackup(r.snap);
  assert.deepEqual([v.ok, v.parts, v.keys, v.problems], [true, 1, 11, []]);
  assert.deepEqual(JSON.stringify(r).includes(KEY1), false);
});

test('манифест: время, число ключей, размеры, sha частей, статистика; список копий', async () => {
  await seed();
  const now = clock();
  const r = await B.runBackup({ now });
  const m = await B.readManifest(r.snap);
  assert.deepEqual([m.v, m.snap, m.at, m.keys, m.prefix, m.parts.length], [1, r.snap, T0, 11, '', 1]);
  assert.match(m.parts[0].sha, /^[0-9a-f]{64}$/);
  assert.equal(m.parts[0].bytes, __read('backup/' + r.snap + '/p0.bin').length);
  assert.equal(m.stats.copied, 11);
  assert.equal(m.stats.temp, 1, 'временный ключ посчитан, не скопирован');
  const list = await B.listBackups();
  assert.deepEqual(list.map((x) => [x.snap, x.complete, x.keys, x.parts]), [[r.snap, true, 11, 1]]);
});

test('части делятся по размеру: сумма записей сходится, каждая часть расшифровывается', async () => {
  await seed(40);
  const r = await B.runBackup({ now: clock(), partBytes: 600, count: 7 });
  assert.equal(r.state, 'done');
  assert.ok(r.parts > 5, 'частей ' + r.parts);
  const v = await B.verifyBackup(r.snap);
  assert.equal(v.ok, true);
  assert.deepEqual((await allRecs(r.snap)).map((x) => x.k).sort(), dbKeys());
  assert.equal(blobKeys().filter((k) => k.endsWith('.bin')).length, r.parts + 1);
});

test('пустая база: копия без частей, проверка проходит', async () => {
  const r = await B.runBackup({ now: clock() });
  assert.deepEqual([r.state, r.parts, r.keys], ['done', 0, 0]);
  assert.deepEqual((await B.verifyBackup(r.snap)).ok, true);
});

test('нет BACKUP_KEY или Redis: ошибка настройки до любых записей в Blob', async () => {
  delete process.env.BACKUP_KEY;
  await assert.rejects(B.runBackup({ now: clock() }), (e) => e.kind === 'config');
  assert.equal(__puts(), 0);
  process.env.BACKUP_KEY = KEY1;
  const saved = [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN];
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  try { await assert.rejects(B.runBackup({ now: clock() }), (e) => e.kind === 'config'); } finally { [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN] = saved; }
  assert.equal(__puts(), 0);
});

/* ---------- ход, замок, продолжение ---------- */
test('бюджет времени кончился: partial, ход сохранён; через срок замка запуск продолжает и заканчивает без потерь и повторов', async () => {
  await seed(30);
  const before = redisState();
  const now = clock();
  let ticks = 0;
  const slow = () => { ticks++; return now() + ticks * 300; }; // каждое обращение к часам «тратит» 0,3 с
  const a = await B.runBackup({ now: slow, budgetMs: 2500, count: 5, partBytes: 300 });
  assert.equal(a.state, 'partial');
  assert.ok(blobKeys().includes(PROGRESS));
  assert.equal(blobKeys().some((k) => k.endsWith('manifest.bin')), false, 'манифеста нет, пока копия не закончена');
  assert.equal((await B.listBackups()).some((x) => x.complete), false);
  const guard = await B.runBackup({ now });
  assert.equal(guard.state, 'busy', 'сразу после предыдущего вызова замок ещё держится');
  let last = a, runs = 1;
  while (last.state !== 'done') {
    now.advance(B.LEASE_MS + 1000); // замок отпущен
    last = await B.runBackup({ now: slow, budgetMs: 2500, count: 5, partBytes: 300 });
    assert.ok(++runs < 40, 'не заканчивается');
  }
  assert.equal(last.snap, a.snap, 'продолжена та же копия');
  assert.ok(runs > 2);
  assert.equal(blobKeys().includes(PROGRESS), false, 'ход убран');
  assert.equal(redisState(), before);
  const keys = (await allRecs(a.snap)).map((x) => x.k);
  assert.deepEqual([...new Set(keys)].sort(), dbKeys());
  assert.equal(keys.length, new Set(keys).size, 'повторов ключей нет');
  assert.equal((await B.verifyBackup(a.snap)).ok, true);
});

test('два запуска одновременно: копию делает один, второй busy; потом ровно одна копия', async () => {
  await seed();
  const now = clock();
  const [x, y] = await Promise.all([B.runBackup({ now }), B.runBackup({ now })]);
  assert.deepEqual([x.state, y.state].sort(), ['busy', 'done']);
  assert.equal(snapsIn().length, 1);
  assert.equal(blobKeys().includes(PROGRESS), false);
});

test('ход перехвачен другим запуском посреди работы: этот останавливается (busy), чужой ход не затёрт', async () => {
  await seed(20);
  const now = clock();
  let n = 0;
  const hook = () => { n++; if (n === 8) __write(PROGRESS, __read(PROGRESS)); return now(); }; // чужая запись меняет ETag
  const r = await B.runBackup({ now: hook, count: 3, partBytes: 200 });
  assert.equal(r.state, 'busy');
  assert.equal(blobKeys().some((k) => k.endsWith('manifest.bin')), false);
});

test('сбой записи части: ошибка наружу, ход не сдвинут; следующий запуск доделывает копию', async () => {
  await seed(10);
  const now = clock();
  __failPutOn('/p0.bin', 1);
  await assert.rejects(B.runBackup({ now, count: 100 }), /simulated outage/);
  assert.equal(blobKeys().some((k) => k.endsWith('manifest.bin')), false);
  assert.ok(blobKeys().includes(PROGRESS));
  now.advance(B.LEASE_MS + 1000);
  const r = await B.runBackup({ now, count: 100 });
  assert.equal(r.state, 'done');
  assert.equal((await B.verifyBackup(r.snap)).ok, true);
  assert.deepEqual([...new Set((await allRecs(r.snap)).map((x) => x.k))].sort(), dbKeys());
});

test('сбой записи манифеста: копия не считается полной; повтор дописывает манифест, не обходя базу заново', async () => {
  await seed(6);
  const now = clock();
  __failPutOn('manifest.bin', 1);
  await assert.rejects(B.runBackup({ now }), /simulated outage/);
  assert.deepEqual((await B.listBackups()).map((x) => x.complete), [false]);
  now.advance(B.LEASE_MS + 1000);
  const putsBefore = __puts();
  const r = await B.runBackup({ now });
  assert.equal(r.state, 'done');
  assert.equal(__puts() - putsBefore, 2, 'записаны только продление хода и манифест, части заново не писались');
  assert.equal((await B.verifyBackup(r.snap)).keys, 13);
});

test('прошлый запуск записал манифест, но не убрал ход: ход убирается, новая копия начинается заново', async () => {
  await seed();
  const now = clock();
  const a = await B.runBackup({ now });
  const stale = { v: 1, snap: a.snap, at: T0, upd: T0, cursor: '0', done: true, n: 1, parts: [], stats: { scanned: 0, copied: 0, gone: 0, changed: 0, foreign: 0, other: {} } };
  const { gzipSync } = await import('node:zlib');
  await blobPut(PROGRESS, B.seal(gzipSync(Buffer.from(JSON.stringify(stale))), 'progress'), { allowOverwrite: false });
  now.advance(DAY);
  const b = await B.runBackup({ now });
  assert.equal(b.state, 'done');
  assert.notEqual(b.snap, a.snap);
  assert.deepEqual((await B.listBackups()).map((x) => x.complete), [true, true]);
});

test('ход устарел (больше 20 часов): прежняя неполная копия удалена, новая начинается с нуля', async () => {
  await seed(20);
  const now = clock();
  let t = 0;
  const slow = () => now() + (++t) * 300;
  const a = await B.runBackup({ now: slow, budgetMs: 2500, count: 3, partBytes: 100 });
  assert.equal(a.state, 'partial');
  const old = snapsIn();
  assert.equal(old.length, 1, 'у неполной копии есть записанные части');
  now.advance(B.STALE_MS + 1000);
  const b = await B.runBackup({ now, count: 100 });
  assert.equal(b.state, 'done');
  assert.deepEqual(snapsIn(), [b.snap]);
  assert.notEqual(b.snap, old[0]);
});

test('ход нельзя прочитать (сменили BACKUP_KEY или файл испорчен): копии не блокируются, ход заменён', async () => {
  await seed(20);
  const now = clock();
  let t = 0;
  const slow = () => now() + (++t) * 300;
  const a = await B.runBackup({ now: slow, budgetMs: 2500, count: 3, partBytes: 100 });
  assert.equal(a.state, 'partial');
  assert.equal(snapsIn().length, 1);
  process.env.BACKUP_KEY = KEY2;
  now.advance(B.LEASE_MS + 1000);
  const b = await B.runBackup({ now, count: 100 });
  assert.equal(b.state, 'done');
  assert.deepEqual(snapsIn(), [b.snap], 'части старого хода убраны как бесхозные');
  process.env.BACKUP_KEY = KEY1;
  assert.equal((await B.listBackups())[0].error, 'key', 'копию под новым ключом не откроет старый');
});

test('испорченный файл хода: копии не блокируются, начинается новая', async () => {
  await seed(20);
  const now = clock();
  let t = 0;
  const a = await B.runBackup({ now: () => now() + (++t) * 300, budgetMs: 2500, count: 3, partBytes: 100 });
  assert.equal(a.state, 'partial');
  __write(PROGRESS, Buffer.from('мусор'));
  now.advance(B.LEASE_MS + 1000);
  const b = await B.runBackup({ now, count: 100 });
  assert.equal(b.state, 'done');
  assert.deepEqual(snapsIn(), [b.snap]);
});

/* ---------- ротация ---------- */
test('хранится 7 полных копий: старые удаляются вместе с частями, новые не трогаются', async () => {
  await seed();
  const now = clock();
  const snaps = [];
  let lastPruned = 0;
  for (let i = 0; i < 9; i++) { const r = await B.runBackup({ now }); snaps.push(r.snap); lastPruned = r.pruned; now.advance(DAY); }
  assert.equal(lastPruned, 1);
  assert.deepEqual(snapsIn().sort(), snaps.slice(2).sort());
  assert.deepEqual((await B.listBackups()).map((x) => x.snap), snaps.slice(2).reverse());
  assert.equal(blobKeys().filter((k) => k.includes(snaps[0])).length, 0);
});

test('keep:1 оставляет одну, самую новую; keep 0 не удаляет всё', async () => {
  await seed();
  const now = clock();
  await B.runBackup({ now }); now.advance(DAY);
  await B.runBackup({ now }); now.advance(DAY);
  const c = await B.runBackup({ now, keep: 1 });
  assert.equal(c.pruned, 2);
  assert.deepEqual(snapsIn(), [c.snap]);
  assert.equal(await B.pruneBackups(0), 0, 'keep 0 заменяется значением по умолчанию, а не стирает всё');
  assert.equal(snapsIn().length, 1);
});

test('бесхозные неполные копии удаляются, живой ход и чужие файлы не трогаются; страницы списка (1300 файлов)', async () => {
  await seed();
  for (let i = 0; i < 1300; i++) await blobPut('backup/orphan-0001/p' + i + '.bin', Buffer.from('x'));
  await blobPut('other/keep.txt', Buffer.from('чужое'));
  await blobPut('backup/readme.txt', Buffer.from('не копия'));
  const r = await B.runBackup({ now: clock() });
  assert.equal(r.pruned, 1);
  assert.equal(snapsIn().length, 1);
  assert.ok(blobKeys().includes('other/keep.txt') && blobKeys().includes('backup/readme.txt'));
});

test('prune не трогает копию, которую ведёт текущий ход', async () => {
  await seed(20);
  const now = clock();
  let t = 0;
  const a = await B.runBackup({ now: () => now() + (++t) * 300, budgetMs: 2500, count: 3, partBytes: 100 });
  assert.equal(a.state, 'partial');
  const before = blobKeys();
  assert.ok(before.some((k) => k.endsWith('/p0.bin')), 'у неполной копии есть части');
  assert.equal(await B.pruneBackups(7), 0);
  assert.deepEqual(blobKeys(), before);
});

/* ---------- проверка и порча ---------- */
async function oneBackup(n = 20) {
  await seed(n);
  return B.runBackup({ now: clock(), partBytes: 400, count: 5 });
}

test('verifyBackup находит: изменённую часть, замену старой частью, удалённую часть, чужой ключ', async () => {
  const r = await oneBackup();
  assert.ok(r.parts >= 3);
  const p0 = 'backup/' + r.snap + '/p0.bin', p1 = 'backup/' + r.snap + '/p1.bin';
  const orig0 = __read(p0), orig1 = __read(p1);

  const c = Buffer.from(orig0); c[c.length - 1] ^= 1; __write(p0, c);
  let v = await B.verifyBackup(r.snap);
  assert.equal(v.ok, false);
  assert.match(v.problems.join('\n'), /часть 0: .*не совпадает с манифестом/);

  __write(p0, orig0); __write(p1, orig0); // подмена: чужая, но валидная часть той же копии
  v = await B.verifyBackup(r.snap);
  assert.match(v.problems.join('\n'), /часть 1: /);
  __write(p1, orig1);
  assert.equal((await B.verifyBackup(r.snap)).ok, true, 'после возврата всё сходится');

  const B_ = await import('@vercel/blob');
  await B_.del(p1);
  v = await B.verifyBackup(r.snap);
  assert.match(v.problems.join('\n'), /часть 1: Не найдена часть 1/);

  process.env.BACKUP_KEY = KEY2;
  await assert.rejects(B.verifyBackup(r.snap), (e) => e.kind === 'key');
});

test('манифест одной копии, положенный под имя другой, не принимается', async () => {
  const a = await oneBackup(3);
  const now = clock(T0 + DAY);
  const b = await B.runBackup({ now });
  __write('backup/' + b.snap + '/manifest.bin', __read('backup/' + a.snap + '/manifest.bin'));
  await assert.rejects(B.readManifest(b.snap), (e) => e.kind === 'tamper');
  const list = await B.listBackups();
  assert.equal(list.find((x) => x.snap === b.snap).error, 'tamper');
});

test('readManifest: нет копии → missing; неверный id → format', async () => {
  await assert.rejects(B.readManifest('20260101t000000-aaaa'), (e) => e.kind === 'missing');
  await assert.rejects(B.readManifest('../etc'), (e) => e.kind === 'format');
  await assert.rejects(B.readManifest('A'), (e) => e.kind === 'format');
});

test('копия с тестовым префиксом: префикс записан в манифест, ключи без префикса', async () => {
  process.env.DB_PREFIX = 't:';
  await db.cmd('HSET', db.key('doc', hex(1)), 'd', '{}', 'v', '1');
  await db.cmd('SET', 'nick:boris', 'не мой префикс');
  const r = await B.runBackup({ now: clock() });
  const m = await B.readManifest(r.snap);
  assert.equal(m.prefix, 't:');
  assert.deepEqual((await allRecs(r.snap)).map((x) => x.k), ['doc:' + hex(1)]);
});

test('копия не меняется со временем: два запуска подряд на неизменной базе дают одинаковые записи (шифртекст разный)', async () => {
  await seed();
  const now = clock();
  const a = await B.runBackup({ now }); now.advance(DAY);
  const b = await B.runBackup({ now });
  const norm = async (s) => (await allRecs(s)).map((r) => JSON.stringify({ ...r, ttl: r.ttl ? 1 : 0 })).sort();
  assert.deepEqual(await norm(a.snap), await norm(b.snap));
  assert.notDeepEqual(__read('backup/' + a.snap + '/p0.bin'), __read('backup/' + b.snap + '/p0.bin'));
});

test('круг на уровне Blob: копия → стирание Redis → восстановление частей из Blob даёт те же ключи', async () => {
  await seed();
  const r = await B.runBackup({ now: clock() });
  const before = {};
  for (const k of __keys()) if (!/^(tgt|rl|tgp):/.test(k)) before[k] = JSON.stringify(__raw(k)); // временные в копию не входят
  for (const k of __keys()) await db.cmd('DEL', k);
  const man = await B.readManifest(r.snap);
  for (const info of man.parts) for (const rec of (await B.readPart(r.snap, man, info.n)).recs) await db.pipe(B.restoreCmds(rec));
  const after = {};
  for (const k of __keys()) after[k] = JSON.stringify(__raw(k));
  assert.deepEqual(after, before);
});

test('остановка по времени в любой момент обхода не теряет записей', async () => {
  for (const N of [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 30]) {
    __reset(); setEnv(); process.env.BACKUP_KEY = KEY1;
    await seed(12);
    const now = clock();
    let calls = 0;
    const cut = () => (++calls > N ? now() + 1e6 : now()); // после N-го обращения к часам «время вышло»
    let last = await B.runBackup({ now: cut, budgetMs: 5000, count: 2 });
    let guard = 0;
    while (last.state !== 'done') { now.advance(2e6); last = await B.runBackup({ now, budgetMs: 5000, count: 2 }); assert.ok(++guard < 20, 'N=' + N + ' не заканчивается'); }
    const keys = (await allRecs(last.snap)).map((x) => x.k);
    assert.deepEqual([...new Set(keys)].sort(), dbKeys(), 'N=' + N);
    assert.equal(keys.length, new Set(keys).size, 'N=' + N + ': повторы');
  }
});

test('BACKUP_DIR: своя папка не смешивается с настоящими копиями и не удаляет их; неверное имя заменяется на backup', async () => {
  await seed();
  const now = clock();
  const real = await B.runBackup({ now });
  process.env.BACKUP_DIR = 'backup-selftest-1';
  now.advance(DAY);
  const t = await B.runBackup({ now, keep: 1 });
  assert.equal(t.pruned, 0, 'копия в другой папке не вытесняет настоящую');
  assert.ok(blobKeys().some((k) => k.startsWith('backup-selftest-1/' + t.snap)));
  assert.ok(blobKeys().some((k) => k.startsWith('backup/' + real.snap)));
  assert.deepEqual((await B.listBackups()).map((x) => x.snap), [t.snap]);
  for (const bad of ['../x', 'a b', '', 'a/b']) { process.env.BACKUP_DIR = bad; assert.deepEqual((await B.listBackups()).map((x) => x.snap), [real.snap], bad); }
  delete process.env.BACKUP_DIR;
});
