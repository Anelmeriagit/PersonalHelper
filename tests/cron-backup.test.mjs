// Этап 4.3: резервная копия внутри api/cron.js (оба слота, ручной ?backup=1, бюджет времени, сбои не мешают рассылке).
// Заглушки Redis, Blob и мок Telegram. Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __keys, __raw } from './redis.mjs';
import { __reset, __keys as blobKeys, __failPutOn, __puts } from './blob.mjs'; // __reset заглушки Blob сбрасывает и Redis
import { mockReq, mockRes, setEnv, linkUser, fakeClock } from './helpers.mjs';

const KEY1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';
setEnv();
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.CRON_SECRET = 'test-cron-secret';
const acc = await import('../api/_acc.js');
const rem = await import('../api/_rem.js');
const B = await import('../api/_backup.js');
const cron = (await import('../api/cron.js')).default;

beforeEach(() => { __reset(); setEnv(); process.env.TELEGRAM_BOT_TOKEN = 'test-token'; process.env.CRON_SECRET = 'test-cron-secret'; process.env.BACKUP_KEY = KEY1; });

const AUTH = { authorization: 'Bearer test-cron-secret' };
const TODAY = () => rem.mskNow().date;
const hex = () => crypto.randomBytes(6).toString('hex');
let tidSeq = 5000;
const mkUser = (nick) => linkUser(acc, nick, { id: ++tidSeq, username: nick });
const addCustom = (id, text) => rem.mutateRem(id, (r) => { r.custom.push({ id: hex(), date: TODAY(), slot: 'day', text, on: true, sent: false }); });
async function run(query = {}, headers = AUTH) {
  const res = mockRes();
  const req = mockReq({ method: 'GET', headers });
  req.query = query;
  await cron(req, res);
  return res;
}
function mockTg(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const m = String(url).match(/api\.telegram\.org\/bot[^/]+\/(\w+)/);
    assert.ok(m, 'неожиданный запрос: ' + url);
    calls.push({ method: m[1], body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  return calls;
}
const sent = (calls) => calls.filter((c) => c.method === 'sendMessage');
const snaps = () => [...new Set(blobKeys().map((k) => /^backup\/([^/]+)\//.exec(k)).filter(Boolean).map((m) => m[1]))];
const completeSnaps = () => blobKeys().filter((k) => k.endsWith('/manifest.bin'));

test('вечерний и дневной слот делают копию; рассылка и копия в одном ответе; копия ничего не пишет в Redis', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna'); await addCustom(a, 'Привет');
  const before = JSON.stringify(__keys().map((k) => [k, __raw(k)]));
  const r = await run();
  assert.equal(r.statusCode, 200);
  assert.equal(sent(calls).length, 1);
  assert.equal(r.body.sent, 1);
  assert.equal(r.body.backup.state, 'done');
  assert.ok(r.body.backup.keys > 3 && r.body.backup.parts === 1 && r.body.backup.pruned === 0);
  assert.equal(completeSnaps().length, 1);
  assert.ok(Object.keys(r.body.backup).every((k) => ['state', 'ms', 'snap', 'parts', 'keys', 'bytes', 'pruned', 'stats'].includes(k)));
  const after = JSON.stringify(__keys().map((k) => [k, __raw(k)]));
  // единственное отличие Redis: отметка «отправлено» у напоминания
  assert.notEqual(before, after);
  assert.equal(__keys().some((k) => k.includes('backup')), false);
  assert.ok(!JSON.stringify(r.body).includes(a) && !JSON.stringify(r.body).includes(KEY1));
  assert.equal(B.verifyBackup && (await B.verifyBackup(r.body.backup.snap)).ok, true);
});

test('дневная копия есть: вечерний слот и следующие 6 суток пропускают (skip); через 7 суток нужна новая; чаще раза в неделю копий не бывает', async (t) => {
  mockTg(t);
  const clock = fakeClock(t);
  await mkUser('anna');
  const day = await run();
  assert.equal(day.body.backup.state, 'done');
  clock.advance(4 * 3600 * 1000);
  const eve = await run({ slot: 'evening' });
  assert.equal(eve.statusCode, 200);
  assert.equal(eve.body.backup.state, 'skip');
  assert.equal(completeSnaps().length, 1);
  for (let d = 1; d <= 5; d++) { // сутки спустя, дневной и вечерний слоты: копия свежая, новой нет
    clock.advance(24 * 3600 * 1000);
    assert.equal((await run()).body.backup.state, 'skip', 'день ' + d);
    assert.equal((await run({ slot: 'evening' })).body.backup.state, 'skip', 'вечер ' + d);
  }
  clock.advance(24 * 3600 * 1000); // с момента копии 6 суток 4 часа
  assert.equal((await run()).body.backup.state, 'skip', 'меньше 7 суток');
  assert.equal(completeSnaps().length, 1);
  clock.advance(24 * 3600 * 1000);
  const next = await run();
  assert.equal(next.body.backup.state, 'done', 'больше 7 суток: новая копия');
  assert.equal(completeSnaps().length, 2);
});

test('интервалы: новая копия раз в 7 суток, незаконченная живёт 3 суток', () => {
  assert.equal(B.DUE_GAP_MS, 7 * 24 * 3600 * 1000);
  assert.equal(B.STALE_MS, 3 * 24 * 3600 * 1000);
  assert.equal(B.KEEP, 7);
});

test('незаконченная копия доделывается ближайшими запусками cron (тот же номер), а после 3 суток начинается заново', async (t) => {
  mockTg(t);
  const db = await import('../api/_db.js');
  for (let i = 0; i < 40; i++) await db.cmd('HSET', 'doc:' + i.toString(16).padStart(32, '0'), 'd', 'x'.repeat(300), 'v', '1');
  let now = Date.UTC(2026, 9, 5, 11, 0, 0);
  let ticks = 0;
  const slow = () => now + ++ticks * 300;
  const part = await B.runBackup({ now: slow, budgetMs: 2500, count: 5, partBytes: 300 }); // день 0: не успела
  assert.equal(part.state, 'partial');
  now += 24 * 3600 * 1000 + 5000; // сутки спустя (меньше 3 суток): продолжается та же копия, а не новая
  const next = await B.backupIfDue({ now: () => now, count: 5 });
  assert.equal(next.state, 'done');
  assert.equal(next.snap, part.snap);
  assert.equal(completeSnaps().length, 1);
  // вторая копия, снова не успевшая; ход старше 3 суток брошен, копия начинается с нуля
  now += B.DUE_GAP_MS + 1000;
  ticks = 0;
  const p2 = await B.runBackup({ now: slow, budgetMs: 2500, count: 5, partBytes: 300 });
  assert.equal(p2.state, 'partial');
  now += B.STALE_MS + 5000;
  const fresh = await B.backupIfDue({ now: () => now, count: 5 });
  assert.notEqual(fresh.snap, p2.snap, 'старый ход брошен');
  assert.equal(fresh.state, 'done');
  assert.equal(snaps().includes(p2.snap), false, 'части брошенной копии удалены');
});

test('сбой копии днём: рассылка уже ушла, ответ 502 с kind; вечерний слот доделывает копию', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = mockTg(t);
  const clock = fakeClock(t);
  const a = await mkUser('anna'); await addCustom(a, 'Привет');
  __failPutOn('/p0.bin', 1);
  const r = await run();
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.sent, 1, 'напоминание доставлено, несмотря на сбой копии');
  assert.equal(sent(calls).length, 1);
  assert.deepEqual([r.body.backup.state, typeof r.body.backup.kind], ['error', 'string']);
  assert.ok(!JSON.stringify(r.body.backup).includes('simulated'), 'текст ошибки хранилища в ответ не попадает');
  assert.equal(completeSnaps().length, 0);
  clock.advance(B.LEASE_MS + 1000);
  const eve = await run({ slot: 'evening' });
  assert.equal(eve.statusCode, 200);
  assert.equal(eve.body.backup.state, 'done');
  assert.equal(sent(calls).length, 1, 'повторной рассылки нет');
  assert.equal(completeSnaps().length, 1);
});

test('сбой рассылки не отменяет копию: аккаунт с ошибкой даёт 502, копия делается', async (t) => {
  t.mock.method(console, 'error', () => {});
  mockTg(t);
  const a = await mkUser('anna');
  await db_corrupt(a);
  const r = await run();
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.errors, 1);
  assert.equal(r.body.backup.state, 'done');
});
async function db_corrupt(id) { // ломаем чтение rem:<id>: запись не того типа
  const db = await import('../api/_db.js');
  await db.cmd('DEL', db.key('rem', id));
  await db.cmd('SET', db.key('rem', id), 'не хэш');
}

test('нет BACKUP_KEY: копия выключена (off), рассылка и код 200 как раньше, в Blob ничего нет', async (t) => {
  delete process.env.BACKUP_KEY;
  const calls = mockTg(t);
  const a = await mkUser('anna'); await addCustom(a, 'Привет');
  const r = await run();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.backup, { state: 'off' });
  assert.equal(sent(calls).length, 1);
  assert.equal(__puts(), 0);
  assert.equal(blobKeys().length, 0);
});

test('мало времени после рассылки: копия пропускается (skipped), ответ 200; следующий слот сделает', async (t) => {
  mockTg(t);
  await mkUser('anna');
  const real = Date.now.bind(Date);
  let calls = 0;
  t.mock.method(Date, 'now', () => real() + (++calls > 3 ? 24000 : 0)); // после рассылки «прошло» 24 с из 30
  const r = await run();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.backup, { state: 'skipped', reason: 'time' });
  assert.equal(__puts(), 0);
});

test('незаконченная копия (partial): вечером 502, днём 200 (вечер доделает)', async (t) => {
  mockTg(t);
  const db = await import('../api/_db.js');
  const fill = async () => { for (let i = 0; i < 3000; i += 100) await db.pipe(Array.from({ length: 100 }, (_, j) => ['HSET', 'doc:' + (i + j).toString(16).padStart(32, '0'), 'd', 'x'.repeat(400), 'v', '1'])); };
  // «медленная» копия: каждое обращение к часам тратит 2 с: бюджет копии (остаток от 30 с) кончается на втором шаге обхода
  const slowClock = () => { const real = Date.now.bind(Date); let n = 0; t.mock.method(Date, 'now', () => real() + ++n * 2000); };
  await fill();
  slowClock();
  const day = await run();
  assert.equal(day.body.backup.state, 'partial', JSON.stringify(day.body.backup));
  assert.equal(day.statusCode, 200);
  t.mock.restoreAll();
  mockTg(t);
  __reset(); setEnv(); process.env.TELEGRAM_BOT_TOKEN = 'test-token'; process.env.CRON_SECRET = 'test-cron-secret'; process.env.BACKUP_KEY = KEY1;
  await fill();
  slowClock();
  const eve = await run({ slot: 'evening' });
  assert.equal(eve.body.backup.state, 'partial');
  assert.equal(eve.statusCode, 502);
});

/* ---------- ручной запуск ---------- */
test('?backup=1: только копия, рассылка не идёт; нужна авторизация; повтор делает вторую копию независимо от давности', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna'); await addCustom(a, 'Привет');
  assert.equal((await run({ backup: '1' }, {})).statusCode, 401);
  const r = await run({ backup: '1' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.backup.state, 'done');
  assert.equal(r.body.sent, undefined);
  assert.equal(sent(calls).length, 0, 'рассылка не запускалась');
  const clock = fakeClock(t);
  clock.advance(1100);
  const r2 = await run({ backup: '1' });
  assert.equal(r2.body.backup.state, 'done');
  assert.equal(completeSnaps().length, 2);
});

test('?backup=1 без BACKUP_KEY: 400 off; при сбое 502; dry показывает состояние и ничего не пишет', async (t) => {
  t.mock.method(console, 'error', () => {});
  mockTg(t);
  delete process.env.BACKUP_KEY;
  const off = await run({ backup: '1' });
  assert.deepEqual([off.statusCode, off.body.backup.state], [400, 'off']);
  process.env.BACKUP_KEY = KEY1;
  await mkUser('anna');
  __failPutOn('progress.bin', 1);
  const bad = await run({ backup: '1' });
  assert.deepEqual([bad.statusCode, bad.body.backup.state], [502, 'error']);
  const putsBefore = __puts();
  const dry = await run({ backup: '1', dry: '1' });
  assert.equal(dry.statusCode, 200);
  assert.deepEqual([dry.body.backup.state, dry.body.backup.copies, dry.body.backup.last, dry.body.backup.due], ['on', 0, null, true]);
  assert.equal(__puts(), putsBefore);
});

test('сухой прогон cron показывает состояние копий (копий, время последней, нужна ли новая), без записи', async (t) => {
  mockTg(t);
  const clock = fakeClock(t);
  await mkUser('anna');
  const putsBefore = __puts();
  const d0 = await run({ dry: '1' });
  assert.deepEqual(d0.body.backup, { state: 'on', blob: false, copies: 0, last: null, running: false, due: true });
  process.env.BLOB_READ_WRITE_TOKEN = 'x';
  assert.equal((await run({ dry: '1' })).body.backup.blob, true, 'видно, задан ли токен Blob (само значение не показывается)');
  assert.ok(!JSON.stringify((await run({ dry: '1' })).body).includes('"x"'));
  delete process.env.BLOB_READ_WRITE_TOKEN;
  assert.equal(__puts(), putsBefore);
  await run();
  clock.advance(3600 * 1000);
  const d1 = await run({ dry: '1' });
  assert.equal(d1.body.backup.copies, 1);
  assert.equal(d1.body.backup.due, false);
  assert.match(d1.body.backup.last, /^\d{4}-\d\d-\d\dT/);
  clock.advance(5 * 24 * 3600 * 1000);
  assert.equal((await run({ dry: '1' })).body.backup.due, false, 'меньше 7 суток');
  clock.advance(2 * 24 * 3600 * 1000);
  assert.equal((await run({ dry: '1' })).body.backup.due, true);
  delete process.env.BACKUP_KEY;
  assert.deepEqual((await run({ dry: '1' })).body.backup, { state: 'off' });
});

test('вспомогательные: snapTime разбирает номер копии, backupStatus считает полные копии и ход', async () => {
  assert.equal(B.snapTime('20261005t180000-ab12'), Date.UTC(2026, 9, 5, 18, 0, 0));
  assert.equal(B.snapTime('мусор'), null);
  await (await import('../api/_db.js')).cmd('SET', 'nick:a', '1');
  const now = () => Date.UTC(2026, 9, 5, 18, 0, 0);
  const r = await B.runBackup({ now });
  const st = await B.backupStatus();
  assert.deepEqual([st.copies, st.lastAt, st.running, st.configured], [1, now(), false, true]);
  assert.equal((await B.backupIfDue({ now })).state, 'skip');
  assert.equal((await B.backupIfDue({ now: () => now() + B.DUE_GAP_MS + 1 })).state, 'done');
  void r;
});

test('backupIfDue: незаконченная копия продолжается, даже если свежая полная уже есть (ручной запуск начал новую)', async () => {
  const db = await import('../api/_db.js');
  for (let i = 0; i < 40; i++) await db.cmd('HSET', 'doc:' + i.toString(16).padStart(32, '0'), 'd', 'x'.repeat(300), 'v', '1');
  let t = Date.UTC(2026, 9, 5, 12, 0, 0);
  const now = () => t;
  assert.equal((await B.runBackup({ now })).state, 'done');
  t += 3600 * 1000; // час спустя ручной запуск начинает новую копию и не успевает
  let ticks = 0;
  const slow = () => t + ++ticks * 300;
  const part = await B.runBackup({ now: slow, budgetMs: 2500, count: 5, partBytes: 300 });
  assert.equal(part.state, 'partial');
  t += B.LEASE_MS + 5000;
  const next = await B.backupIfDue({ now, count: 5 });
  assert.notEqual(next.state, 'skip');
  assert.equal(next.snap, part.snap, 'продолжена начатая копия');
});

test('BACKUP_KEY задан, но негоден (опечатка, не тот формат, слишком простой): это ошибка config и 502, а не тихое off; рассылка работает', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = mockTg(t);
  const a = await mkUser('anna'); await addCustom(a, 'Привет');
  for (const bad of ['abc', KEY1.slice(2), KEY1 + 'ab', '"' + KEY1 + '"', 'z'.repeat(64), '0'.repeat(64)]) {
    process.env.BACKUP_KEY = bad;
    const dry = await run({ dry: '1' });
    assert.deepEqual([dry.statusCode, dry.body.backup.state, dry.body.backup.kind], [200, 'error', 'config'], bad.slice(0, 6));
    const man = await run({ backup: '1' });
    assert.deepEqual([man.statusCode, man.body.backup.state, man.body.backup.kind], [502, 'error', 'config'], bad.slice(0, 6));
    assert.ok(!JSON.stringify(man.body).includes(bad.slice(0, 20)) || bad.length < 20);
  }
  process.env.BACKUP_KEY = 'abc';
  const r = await run();
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.sent, 1, 'напоминание ушло');
  assert.equal(sent(calls).length, 1);
  assert.deepEqual(r.body.backup, { state: 'error', kind: 'config' });
  assert.equal(__puts(), 0);
  for (const empty of ['', '   ']) { process.env.BACKUP_KEY = empty; assert.deepEqual((await run({ dry: '1' })).body.backup, { state: 'off' }, 'пустое значение = не задан'); }
});
