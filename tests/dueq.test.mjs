// Этап 5, переход на внешний планировщик, часть 3: индекс dueq (api/_due.js, _reindex.js; расчёт в _rem.js; чтение в api/cron.js).
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test as rawTest, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __reset, __zset, __keys, __raw, __cmdLog, __fail, __after } from './redis.mjs';
import { mockReq, mockRes, setEnv, linkUser, mkAccount, pinMsk } from './helpers.mjs';

// Каждый тест идёт в 14:30 по Москве 2026-10-14 (дневной слот наступил, вечерний нет).
const test = (name, fn) => rawTest(name, (t) => { pinMsk(t, 14, 30); return fn(t); });

setEnv();
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.CRON_SECRET = 'test-cron-secret';
const lib = await import('../api/_lib.js');
const acc = await import('../api/_acc.js');
const rem = await import('../api/_rem.js');
const due = await import('../api/_due.js');
const { rebuildDue, reindexAccount } = await import('../api/_reindex.js');
const backup = await import('../api/_backup.js');
const db = await import('../api/_db.js');
const cron = (await import('../api/cron.js')).default;
const custom = (await import('../api/custom.js')).default;

beforeEach(() => { __reset(); setEnv(); process.env.TELEGRAM_BOT_TOKEN = 'test-token'; process.env.CRON_SECRET = 'test-cron-secret'; });

const AUTH = { authorization: 'Bearer test-cron-secret' };
const TODAY = '2026-10-14';
const at = (date, slot) => rem.slotMs(date, slot);
const hex = () => crypto.randomBytes(6).toString('hex');
const hex32 = () => crypto.randomBytes(16).toString('hex');
let tid = 7000;
const mkUser = (nick) => linkUser(acc, nick, { id: ++tid, username: nick });
const addC = (id, text, slot = 'h14', date = TODAY) => rem.mutateRem(id, (r) => { r.custom.push({ id: hex(), date, slot, text, on: true, sent: false }); });
const scores = () => Object.fromEntries(__zset('dueq').map(([m, s]) => [m.slice(0, 8) === m ? m : m, s]));
const scoreOf = (m) => { const e = __zset('dueq').find((x) => x[0] === m); return e ? e[1] : null; };
const members = () => __zset('dueq').map((x) => x[0]);
async function run(query = {}) {
  const res = mockRes();
  const req = mockReq({ method: 'GET', headers: AUTH });
  req.query = query;
  await cron(req, res);
  return res;
}
function mockTg(t, onSend) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const m = String(url).match(/api\.telegram\.org\/bot[^/]+\/(\w+)/);
    assert.ok(m, 'неожиданный запрос: ' + url);
    const body = JSON.parse(opts.body);
    calls.push({ method: m[1], body });
    if (onSend && m[1] === 'sendMessage') await onSend(body);
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  return calls;
}
const texts = (calls) => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text);

/* ---------- расчёт ближайшей отправки ---------- */
test('slotMs и dayEndMs: Москва UTC+3, старые слоты day и evening равны h14 и h18', () => {
  assert.equal(at(TODAY, 'h15'), Date.parse('2026-10-14T12:00:00Z'));
  assert.equal(at(TODAY, 'h07'), Date.parse('2026-10-14T04:00:00Z'));
  assert.equal(at(TODAY, 'day'), at(TODAY, 'h14'));
  assert.equal(at(TODAY, 'evening'), at(TODAY, 'h18'));
  assert.equal(rem.dayEndMs(TODAY), Date.parse('2026-10-14T20:59:59.999Z'));
  assert.equal(rem.dayEndMs(TODAY) + 1, Date.parse('2026-10-15T00:00:00+03:00'));
});

test('nextDueRem: ближайшее из временных и повторяющихся; выключенное, отправленное и вчерашнее не считается', () => {
  const now = { date: TODAY };
  const C = (o) => ({ id: hex(), date: TODAY, slot: 'h15', text: 'x', on: true, sent: false, ...o });
  const R = (o) => ({ id: hex(), date: '2026-10-07', every: 'week', slot: 'h09', text: 'x', on: true, sent: {}, ...o });
  assert.equal(rem.nextDueRem({ custom: [], recurring: [] }, now), null);
  assert.equal(rem.nextDueRem({ custom: [C({ slot: 'h18' }), C({ date: '2026-10-20', slot: 'h08' }), C({ slot: 'h16' })], recurring: [] }, now), at(TODAY, 'h16'));
  assert.equal(rem.nextDueRem({ custom: [C({ on: false }), C({ sent: true }), C({ date: '2026-10-13' })], recurring: [] }, now), null);
  assert.equal(rem.nextDueRem({ custom: [C({ slot: 'h07' })], recurring: [] }, now), at(TODAY, 'h07'), 'час уже прошёл: пора сразу (догонка)');
  // повторяющееся: от 7 октября каждую неделю, сегодня (14-го) ровно неделя
  assert.equal(rem.nextDueRem({ custom: [], recurring: [R()] }, now), at(TODAY, 'h09'));
  assert.equal(rem.nextDueRem({ custom: [], recurring: [R({ sent: { [TODAY]: true } })] }, now), at('2026-10-21', 'h09'), 'сегодняшнее ушло: следующее через неделю');
  assert.equal(rem.nextDueRem({ custom: [], recurring: [R({ on: false })] }, now), null);
  assert.equal(rem.nextDueRem({ custom: [], recurring: [R({ date: '2027-04-30', every: 'month' })] }, now), at('2027-04-30', 'h09'), 'первое срабатывание дальше 70 дней: берётся дата отсчёта');
  assert.equal(rem.nextDueRem({ custom: [], recurring: [R({ date: '2026-01-31', every: 'month' })] }, now), at('2026-10-31', 'h09'));
  assert.equal(rem.nextDueRem({ custom: [C({ slot: 'day' })], recurring: [] }, now), at(TODAY, 'h14'));
});

test('nextDueShr: считаются только стороны из списка; отметка и галочка берутся по стороне', () => {
  const now = { date: TODAY };
  const C = (o) => ({ id: hex(), date: TODAY, slot: 'h15', text: 'x', on: { a: true, b: true }, sent: { a: false, b: false }, ...o });
  const R = (o) => ({ id: hex(), date: '2026-10-07', every: 'week', slot: 'h09', text: 'x', on: { a: true, b: true }, sent: {}, ...o });
  const shr = { custom: [C({ slot: 'h16', on: { a: false, b: true } }), C({ slot: 'h18', sent: { a: true, b: false } })], recurring: [] };
  assert.equal(rem.nextDueShr(shr, now, ['a', 'b']), at(TODAY, 'h16'));
  assert.equal(rem.nextDueShr(shr, now, ['a']), null, 'у стороны a: первое выключено, второе ушло');
  assert.equal(rem.nextDueShr(shr, now, ['b']), at(TODAY, 'h16'));
  const rec = { custom: [], recurring: [R({ sent: { [TODAY]: { a: true, b: false } } })] };
  assert.equal(rem.nextDueShr(rec, now, ['a']), at('2026-10-21', 'h09'));
  assert.equal(rem.nextDueShr(rec, now, ['b']), at(TODAY, 'h09'));
});

/* ---------- запись: только понижает ---------- */
test('mutateRem: счёт понижается, никогда не повышается и не удаляется при записи (это делает cron)', async () => {
  const a = await mkAccount(acc, 'anna');
  await addC(a, 'поздно', 'h18', '2026-10-20');
  assert.equal(scoreOf(a), at('2026-10-20', 'h18'));
  await addC(a, 'раньше', 'h10', '2026-10-15');
  assert.equal(scoreOf(a), at('2026-10-15', 'h10'));
  await addC(a, 'ещё позже', 'h10', '2026-10-30');
  assert.equal(scoreOf(a), at('2026-10-15', 'h10'), 'позднее напоминание счёт не меняет');
  await rem.mutateRem(a, (r) => { r.custom = r.custom.filter((x) => x.text !== 'раньше'); });
  assert.equal(scoreOf(a), at('2026-10-15', 'h10'), 'удалили ближайшее: счёт остался прежним (запас вниз безопасен), уточнит cron');
  await rem.mutateRem(a, (r) => { r.custom.length = 0; });
  assert.deepEqual(members(), [a], 'пустая запись член не убирает');
});

test('запись, которая ничего не меняет, и ошибка fn индекс не трогают', async () => {
  const a = await mkAccount(acc, 'anna');
  await addC(a, 'x', 'h18', '2026-10-20');
  __cmdLog(true);
  await rem.mutateRem(a, () => {});
  await rem.mutateRem(a, () => ({ err: 'нет' }));
  assert.equal(__cmdLog().some((c) => c.startsWith('ZADD')), false);
});

test('POST/PUT/DELETE /api/custom ведут индекс; opt.due === false индекс не трогает', async () => {
  const a = await mkAccount(acc, 'anna');
  const call = async (method, body, query) => { const res = mockRes(); const req = mockReq({ method, headers: { cookie: lib.makeCookie(a).split(';')[0], 'content-type': 'application/json' }, body }); req.query = query || {}; await custom(req, res); return res; };
  const r = await call('POST', { date: '2026-10-16', slot: 'h12', text: 'через два дня' });
  assert.equal(r.statusCode, 200);
  assert.equal(scoreOf(a), at('2026-10-16', 'h12'));
  const id = r.body.custom[0].id;
  assert.equal((await call('PUT', { id, date: '2026-10-15' })).statusCode, 200);
  assert.equal(scoreOf(a), at('2026-10-15', 'h12'), 'перенос на раньше понизил счёт');
  assert.equal((await call('DELETE', undefined, { id })).statusCode, 200);
  assert.equal(scoreOf(a), at('2026-10-15', 'h12'), 'удаление запас оставляет');
  const b = await mkAccount(acc, 'boris');
  await rem.mutateRem(b, (r2) => { r2.custom.push({ id: hex(), date: TODAY, slot: 'h14', text: 'x', on: true, sent: false }); }, { due: false });
  assert.equal(scoreOf(b), null);
});

test('сбой индекса после записи не ломает запись: данные сохранены, ошибка в журнале', async (t) => {
  const errs = t.mock.method(console, 'error', () => {});
  const a = await mkAccount(acc, 'anna');
  __fail('http', 'dueq');
  const r = await rem.mutateRem(a, (x) => { x.custom.push({ id: hex(), date: TODAY, slot: 'h18', text: 'x', on: true, sent: false }); });
  __fail(null);
  assert.equal(r.rem.custom.length, 1);
  assert.equal((await rem.readRem(a)).rem.custom.length, 1);
  assert.equal(errs.mock.callCount() > 0, true);
  assert.deepEqual(members(), []);
});

/* ---------- примитивы ---------- */
test('dueSet: меняет счёт только если он не менялся; null — убрать; dueLower не перетирает меньший', async () => {
  await due.dueLower('m1', 1000);
  await due.dueLower('m1', 2000);
  assert.equal(scoreOf('m1'), 1000);
  assert.equal(await due.dueSet('m1', 2000, 3000), false);
  assert.equal(scoreOf('m1'), 1000, 'счёт успели понизить: остаётся');
  assert.equal(await due.dueSet('m1', 1000, 3000), true);
  assert.equal(scoreOf('m1'), 3000);
  assert.equal(await due.dueSet('m1', 3000, null), true);
  assert.deepEqual(members(), []);
  assert.equal(await due.dueSet('m2', null, 5), true, 'члена не было: добавляем');
  assert.equal(await due.dueSet('m2', null, 6), false, 'член уже есть: не затираем');
  assert.equal(await due.dueSet('нет', 7, null), false);
});

test('parseMember: аккаунт, пара (меньший id первым) и мусор', () => {
  const a = '1'.repeat(32), b = '2'.repeat(32);
  assert.deepEqual(due.parseMember(a), { kind: 'acc', id: a });
  assert.deepEqual(due.parseMember(due.pairMember(b, a)), { kind: 'pair', a, b });
  assert.equal(due.pairMember(a, b), due.pairMember(b, a));
  for (const x of ['', 'p:' + a, 'p:' + b + ':' + a, 'p:' + a + ':' + a, 'zzz', 'p:' + a + ':xyz', a + '0']) assert.equal(due.parseMember(x), null, x);
});

/* ---------- cron читает индекс ---------- */
test('cron берёт только тех, кому пора: будущее и чужие аккаунты не читаются; после отправки счёт уточняется', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna'), b = await mkUser('boris'), c = await mkUser('clara');
  await addC(a, 'день Анны'); await addC(a, 'вечер Анны', 'h18');
  await addC(b, 'вечер Бориса', 'h18');
  await addC(c, 'завтра', 'h14', '2026-10-15');
  __cmdLog(true);
  const r = await run();
  const log = __cmdLog();
  assert.deepEqual([r.statusCode, r.body.accounts, r.body.due, r.body.sent, r.body.left], [200, 1, 1, 1, 0]);
  assert.deepEqual(texts(calls), ['🔔 день Анны']);
  assert.equal(log.some((x) => x.includes(b) || x.includes(c)), false, 'Борис и Клара не читались: ' + log.join(' | '));
  assert.equal(scoreOf(a), at(TODAY, 'h18'), 'у Анны остался вечер');
  assert.equal(scoreOf(b), at(TODAY, 'h18'));
  assert.equal(scoreOf(c), at('2026-10-15', 'h14'));
  assert.equal((await run()).body.accounts, 0, 'повторный запуск ничего не берёт');
  pinMsk(t, 18, 5);
  const r2 = await run();
  assert.deepEqual([r2.body.accounts, r2.body.sent], [2, 2]);
  assert.deepEqual(texts(calls).slice(1).sort(), ['🔔 вечер Анны', '🔔 вечер Бориса']);
  assert.deepEqual(members(), [c], 'у ушедших членов нет будущего: убраны, у Клары завтра осталось');
});

test('запись, не менявшая ничего важного (выключили единственное ближайшее): cron разбирает запас один раз и убирает член', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna');
  await addC(a, 'выкл');
  await rem.mutateRem(a, (r) => { r.custom[0].on = false; });
  assert.equal(scoreOf(a), at(TODAY, 'h14'), 'запас вниз остался');
  const r = await run();
  assert.deepEqual([r.statusCode, r.body.accounts, r.body.sent], [200, 1, 0]);
  assert.deepEqual(members(), []);
  assert.equal(calls.length, 0);
  assert.equal((await run()).body.accounts, 0);
});

test('повторяющееся: после отправки счёт уходит на следующую дату; вчерашнее неотправленное не держит член', async (t) => {
  mockTg(t);
  const a = await mkUser('anna');
  await rem.mutateRem(a, (r) => { r.recurring.push({ id: hex(), date: TODAY, every: 'week', slot: 'h09', text: 'раз в неделю', on: true, sent: {} }); });
  await rem.mutateRem(a, (r) => { r.custom.push({ id: hex(), date: '2026-10-13', slot: 'h09', text: 'вчера', on: true, sent: false }); });
  assert.equal(scoreOf(a), at(TODAY, 'h09'), 'вчерашнее не считается даже при записи: счёт по повторяющемуся');
  const r = await run();
  assert.deepEqual([r.body.accounts, r.body.sent], [1, 1]);
  assert.equal(scoreOf(a), at('2026-10-21', 'h09'), 'вчерашнее не догоняется, повторное — через неделю');
});

test('ручной слот смотрит до конца суток; сухой прогон с date — до конца этой даты; без них — только то, что пора сейчас', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna'), b = await mkUser('boris');
  await addC(a, 'вечер Анны', 'h18');
  await addC(b, 'завтра Бориса', 'h08', '2026-10-15');
  const d0 = await run({ dry: '1' });
  assert.deepEqual([d0.body.accounts, d0.body.would_send], [0, 0], 'сейчас 14:30: никому не пора');
  const d1 = await run({ dry: '1', date: '2026-10-14' });
  assert.deepEqual([d1.body.accounts, d1.body.would_send], [1, 1]);
  const d2 = await run({ dry: '1', date: '2026-10-15' });
  assert.deepEqual([d2.body.accounts, d2.body.would_send], [2, 1], 'на 15-е в индексе оба, но вечерняя Анны сегодняшняя: по дате 15-го слать нечего');
  assert.equal(scoreOf(a), at(TODAY, 'h18'), 'сухой прогон индекс не трогает');
  const m = await run({ slot: 'h18' });
  assert.deepEqual([m.body.accounts, m.body.sent], [1, 1]);
  assert.deepEqual(texts(calls), ['🔔 вечер Анны']);
  assert.equal(scoreOf(b), at('2026-10-15', 'h08'), 'у Бориса ничего не тронуто');
});

test('запись во время отправки понижает счёт: cron его не затирает, следующий запуск разберёт', async (t) => {
  const a = await mkUser('anna');
  await addC(a, 'день');
  await addC(a, 'потом', 'h18');
  let once = true;
  mockTg(t, async () => { if (once) { once = false; await due.dueLower(a, at(TODAY, 'h14') - 3600000); } }); // «пользователь записал» между чтением и уточнением
  const r = await run();
  assert.equal(r.body.sent, 1);
  assert.equal(scoreOf(a), at(TODAY, 'h14') - 3600000, 'чужое понижение осталось');
  const r2 = await run();
  assert.deepEqual([r2.body.accounts, r2.body.sent], [1, 0]);
  assert.equal(scoreOf(a), at(TODAY, 'h18'), 'второй запуск уточнил');
});

test('сбой отправки: неудавшееся снова «пора» (unclaim понижает счёт), доставленное не повторяется', async (t) => {
  t.mock.method(console, 'error', () => {});
  const a = await mkUser('anna');
  await addC(a, 'раз'); await addC(a, 'два');
  let fail = true;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (fail && body.text === '🔔 два') return new Response(JSON.stringify({ ok: false, description: 'Bad Gateway' }), { status: 502 });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  const r = await run();
  assert.deepEqual([r.statusCode, r.body.sent, r.body.failed], [502, 1, 1]);
  assert.equal(scoreOf(a), at(TODAY, 'h14'), 'неудавшееся осталось в индексе');
  fail = false;
  const r2 = await run();
  assert.deepEqual([r2.statusCode, r2.body.sent], [200, 1]);
  assert.deepEqual(members(), []);
});

test('чужой и испорченный член убирается; несуществующий аккаунт разбирается и убирается', async (t) => {
  mockTg(t);
  await due.dueLower('мусор', 1);
  await due.dueLower(hex32(), 1);
  await due.dueLower(due.pairMember(hex32(), hex32()), 1);
  const r = await run();
  assert.deepEqual([r.statusCode, r.body.junk, r.body.accounts], [200, 1, 3]);
  assert.deepEqual(members(), []);
});

test('больше DUE_LIMIT готовых членов: запуск берёт 600, остальное добирает следующий (left, 502)', async (t) => {
  mockTg(t);
  for (let i = 0; i < 601; i++) await due.dueLower(hex32(), i);
  const r = await run();
  assert.deepEqual([r.statusCode, r.body.accounts, r.body.left], [502, 600, 1]);
  assert.equal(members().length, 1);
  const r2 = await run();
  assert.deepEqual([r2.statusCode, r2.body.accounts, r2.body.left], [200, 1, 0]);
  assert.deepEqual(members(), []);
});

test('пара: член p:… даёт обоих аккаунтов; сторона без привязки не держит член; привязка (reindexAccount) возвращает', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna'), b = await mkAccount(acc, 'boris');
  const { token } = await acc.createPairToken(a);
  assert.ok((await acc.joinPair(token, b)).id);
  await rem.mutateShr(a, b, (s) => { s.custom.push(rem.newShrCustom({ id: hex(), date: TODAY, slot: 'h14', text: 'общее' })); });
  const pm = due.pairMember(a, b);
  assert.equal(scoreOf(pm), at(TODAY, 'h14'));
  const r = await run();
  assert.deepEqual([r.body.accounts, r.body.sent, r.body.nolink], [2, 1, 1]);
  assert.deepEqual(members(), []);
  const { token: lt } = await acc.createLinkToken(b);
  await acc.bindTelegram(lt, { id: ++tid, username: 'boris' }, tid * 100 + 1);
  await reindexAccount(b);
  assert.equal(scoreOf(pm), at(TODAY, 'h14'));
  const r2 = await run();
  assert.deepEqual([r2.body.accounts, r2.body.sent], [2, 1]);
  assert.equal(texts(calls).length, 2);
  assert.deepEqual(members(), []);
});

/* ---------- удаление ---------- */
test('разрыв связи, новая связь и удаление аккаунта убирают члены индекса', async () => {
  const a = await mkAccount(acc, 'anna'), b = await mkAccount(acc, 'boris'), c = await mkAccount(acc, 'clara');
  const { token } = await acc.createPairToken(a);
  await acc.joinPair(token, b);
  await addC(a, 'x'); await addC(b, 'y'); await addC(c, 'z');
  await rem.mutateShr(a, b, (s) => { s.custom.push(rem.newShrCustom({ id: hex(), date: TODAY, slot: 'h14', text: 'общее' })); });
  assert.equal(members().length, 4);
  await acc.unpair(a);
  assert.deepEqual(members().sort(), [a, b, c].sort(), 'пара убрана вместе с общей записью');
  await due.dueLower(due.pairMember(a, b), 5); // залежавшийся член прежней связи
  const t2 = await acc.createPairToken(a);
  await acc.joinPair(t2.token, b);
  assert.equal(scoreOf(due.pairMember(a, b)), null, 'новая связь не наследует старого члена');
  await acc.deleteAccount(c);
  assert.deepEqual(members().sort(), [a, b].sort());
  await addC(a, 'w');
  await rem.mutateShr(a, b, (s) => { s.custom.push(rem.newShrCustom({ id: hex(), date: TODAY, slot: 'h14', text: 'общее' })); });
  await acc.deleteAccount(a);
  assert.deepEqual(members(), [b]);
});

/* ---------- перестройка ---------- */
async function lostIndex() { // базу и индекс подготавливаем так, как их видит перестройка: утерян весь dueq
  const a = await mkUser('anna'), b = await mkUser('boris'), c = await mkUser('clara'), d = await mkAccount(acc, 'dina'); // d без Telegram
  await addC(a, 'Анна', 'h18'); await addC(b, 'Борис', 'h15', '2026-10-16'); await addC(d, 'Дина', 'h18');
  const { token } = await acc.createPairToken(a);
  await acc.joinPair(token, b);
  await rem.mutateShr(a, b, (s) => { s.custom.push(rem.newShrCustom({ id: hex(), date: TODAY, slot: 'h20', text: 'общее' })); });
  return { a, b, c, d };
}

test('rebuildDue: сухой прогон считает, но не пишет; запись добавляет потерянное, правит завышенное, убирает лишнее', async () => {
  const { a, b, c, d } = await lostIndex();
  await db.cmd('DEL', db.key('dueq'));
  await due.dueLower(c, 12345); // у Клары слать нечего: лишний член
  await due.dueLower(hex32(), 5); // аккаунт, которого нет
  await due.dueLower(a, at(TODAY, 'h18') + 86400000); // завышенный счёт
  await due.dueLower(d, 5); // без Telegram: не в tgs
  const before = JSON.stringify(__zset('dueq'));
  const dry = await rebuildDue({ dry: true });
  assert.deepEqual([dry.state, dry.accounts, dry.indexed, dry.add, dry.change, dry.drop, dry.same], ['ok', 3, 4, 2, 1, 3, 0]);
  assert.equal(JSON.stringify(__zset('dueq')), before, 'сухой прогон ничего не записал');
  const r = await rebuildDue();
  assert.deepEqual([r.state, r.lost, r.errors], ['ok', 0, 0]);
  assert.deepEqual(Object.fromEntries(__zset('dueq')), { [a]: at(TODAY, 'h18'), [b]: at('2026-10-16', 'h15'), [due.pairMember(a, b)]: at(TODAY, 'h20') });
  const again = await rebuildDue();
  assert.deepEqual([again.add, again.change, again.drop, again.same], [0, 0, 0, 4], 'второй проход ничего не меняет');
});

test('rebuildDue: стороны без привязки в паре не учитываются; неполный обход ничего не стирает', async () => {
  const a = await mkUser('anna'), b = await mkAccount(acc, 'boris');
  const { token } = await acc.createPairToken(a);
  await acc.joinPair(token, b);
  await rem.mutateShr(a, b, (s) => { const it = rem.newShrCustom({ id: hex(), date: TODAY, slot: 'h20', text: 'общее' }); it.on[rem.sideOf(a, b)] = false; s.custom.push(it); });
  const pm = due.pairMember(a, b);
  const x = hex32();
  await due.dueLower(x, 5);
  assert.equal((await rebuildDue()).state, 'ok');
  assert.deepEqual(members(), [], 'у стороны a галочка выключена, у b нет Telegram: слать некому; лишний член убран');
  await due.dueLower(x, 5);
  const p = await rebuildDue({ budgetMs: -1 });
  assert.equal(p.state, 'partial');
  assert.deepEqual(members(), [x], 'ничего не посещено: лишнее не стёрто');
  assert.equal(scoreOf(pm), null);
});

test('rebuildDue: сбой чтения аккаунта — partial и ничего лишнего не стёрто', async (t) => {
  t.mock.method(console, 'error', () => {});
  const a = await mkUser('anna'); await addC(a, 'x', 'h18');
  const lost = hex32(); await due.dueLower(lost, 5);
  __fail('http', 'rem:' + a);
  const r = await rebuildDue();
  __fail(null);
  assert.deepEqual([r.state, r.errors], ['partial', 1]);
  assert.deepEqual(members().sort(), [a, lost].sort());
});

test('rebuildDue: правка по счёту, который успели понизить, не применяется (lost) — запись напоминаний сильнее перестройки', async () => {
  const a = await mkUser('anna'); await addC(a, 'x', 'h18');
  await due.dueLower(a, at(TODAY, 'h18') + 1000); // нельзя: LT не повысит; ставим напрямую
  await db.cmd('ZADD', db.key('dueq'), at(TODAY, 'h18') + 1000, a); // завышенный счёт
  __after('ZRANGE', () => { db.cmd('ZADD', db.key('dueq'), 'LT', at(TODAY, 'h14'), a); }); // пользователь записал сразу после чтения индекса
  const r = await rebuildDue();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.lost, 1);
  assert.equal(scoreOf(a), at(TODAY, 'h14'));
});

test('/api/cron?rebuild=1: перестройка идёт и при пропущенном запуске (основной жив), сухой прогон ничего не пишет, занятый замок — busy, сбой — 502', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = mockTg(t);
  const a = await mkUser('anna'); await addC(a, 'вечер', 'h18');
  await run(); // основной: пульс
  await db.cmd('DEL', db.key('dueq'));
  const dr = await run({ role: 'backup', rebuild: '1', dry: '1' });
  assert.deepEqual([dr.statusCode, dr.body.rebuild.state, dr.body.rebuild.add], [200, 'ok', 1]);
  assert.deepEqual(members(), [], 'сухой прогон: индекс не тронут');
  const r = await run({ role: 'backup', rebuild: '1' });
  assert.deepEqual([r.statusCode, r.body.skipped, r.body.rebuild.state, r.body.rebuild.add], [200, 'primary alive', 'ok', 1]);
  assert.equal(scoreOf(a), at(TODAY, 'h18'));
  assert.equal(__raw(db.key('cron', 'rb')), undefined, 'замок перестройки снят');
  await db.cmd('SET', db.key('cron', 'rb'), 'чужой', 'PX', 60000);
  const busy = await run({ role: 'backup', rebuild: '1' });
  assert.deepEqual([busy.statusCode, busy.body.rebuild.state], [200, 'busy']);
  await db.cmd('DEL', db.key('cron', 'rb'));
  __fail('http', 'tgs');
  const bad = await run({ rebuild: '1' });
  __fail(null);
  assert.deepEqual([bad.statusCode, bad.body.rebuild.state], [502, 'error']);
  assert.equal(typeof bad.body.rebuild.kind, 'string');
  assert.equal(bad.body.accounts, 0, 'рассылка при этом шла');
  assert.equal(calls.length, 0);
});

/* ---------- копия ---------- */
test('копия: dueq сохраняется как zset (запись t:z), восстановление возвращает члены и счета', async () => {
  const a = await mkUser('anna'); await addC(a, 'x', 'h18');
  const recs = [];
  let cur = '0';
  do { const r = await backup.readBatch(cur, { count: 1000 }); recs.push(...r.recs); cur = r.cursor; } while (cur !== '0');
  const z = recs.find((x) => x.k === 'dueq');
  assert.deepEqual(z, { k: 'dueq', t: 'z', v: [[a, String(at(TODAY, 'h18'))]] });
  assert.equal(backup.validRec(z), true);
  assert.equal(backup.validRec({ k: 'dueq', t: 'z', v: [[a, 'не число']] }), false);
  assert.equal(backup.validRec({ k: 'dueq', t: 'z', v: [] }), false);
  const cmds = backup.restoreCmds(z, 'r');
  assert.deepEqual(cmds, [['DEL', 'r:dueq'], ['ZADD', 'r:dueq', String(at(TODAY, 'h18')), a]]);
  await db.pipe(cmds);
  assert.deepEqual(__zset('r:dueq'), [[a, at(TODAY, 'h18')]]);
});
