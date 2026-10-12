// Часовые пояса, часть 2: напоминания, индекс dueq, cron и обработчики по поясу аккаунта; общие напоминания пары по настенным часам каждой стороны;
// смена пояса (set-tz) пересчитывает индекс. Время подменяется (pinMsk: 2026-10-14, час по Москве; Берлин UTC+2, Токио +9, Окленд +13, Лос-Анджелес −7).
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __reset, __zset, __cmdLog } from './redis.mjs';
import { mockReq, mockRes, setEnv, mkAccount, linkUser, pinMsk, mockTg } from './helpers.mjs';

setEnv();
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.CRON_SECRET = 'test-cron-secret';
const lib = await import('../api/_lib.js');
const acc = await import('../api/_acc.js');
const rem = await import('../api/_rem.js');
const tzm = await import('../api/_tz.js');
const { rebuildDue } = await import('../api/_reindex.js');
const auth = (await import('../api/auth.js')).default;
const reminders = (await import('../api/reminders.js')).default;
const custom = (await import('../api/custom.js')).default;
const cron = (await import('../api/cron.js')).default;

beforeEach(() => { __reset(); setEnv(); process.env.TELEGRAM_BOT_TOKEN = 'test-token'; process.env.CRON_SECRET = 'test-cron-secret'; });

const TODAY = '2026-10-14';
const BER = 'Europe/Berlin', MSK = 'Europe/Moscow', AKL = 'Pacific/Auckland', LAX = 'America/Los_Angeles', TYO = 'Asia/Tokyo';
const utc = (s) => Date.parse(s);
const hex = () => crypto.randomBytes(6).toString('hex');
let tid = 9000;
const chatOf = (uid) => String(uid * 100 + 1);
async function mkLinked(nick, tz) {
  const uid = ++tid;
  const id = await linkUser(acc, nick, { id: uid, username: nick });
  if (tz) await acc.setTz(id, tz);
  return { id, chat: chatOf(uid) };
}
const addC = (id, text, slot, date = TODAY) => rem.mutateRem(id, (r) => { r.custom.push({ id: hex(), date, slot, text, on: true, sent: false }); });
const scoreOf = (m) => { const e = __zset('dueq').find((x) => x[0] === m); return e ? e[1] : null; };
async function run(query = {}) {
  const res = mockRes();
  const req = mockReq({ method: 'GET', headers: { authorization: 'Bearer test-cron-secret' } });
  req.query = query;
  await cron(req, res);
  return res;
}
const sent = (calls) => calls.filter((c) => c.method === 'sendMessage').map((c) => [String(c.body.chat_id), c.body.text]);
async function call(h, method, id, body, query) {
  const res = mockRes();
  const req = mockReq({ method, headers: { cookie: lib.makeCookie(id).split(';')[0], ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body });
  req.query = query || {};
  await h(req, res);
  return res;
}
const post = (h, id, body) => call(h, 'POST', id, body);

/* ---------- индекс: счёт по поясу ---------- */
test('mutateRem: счёт в индексе — момент слота по поясу владельца (Москва, Берлин, Токио); без tz Москва', async (t) => {
  pinMsk(t, 12, 0);
  const m = await mkLinked('moscow'), b = await mkLinked('berlin', BER), j = await mkLinked('tokyo', TYO);
  for (const x of [m, b, j]) await addC(x.id, 'x', 'h14');
  assert.equal(scoreOf(m.id), utc('2026-10-14T11:00:00Z'));
  assert.equal(scoreOf(b.id), utc('2026-10-14T12:00:00Z'));
  assert.equal(scoreOf(j.id), utc('2026-10-14T05:00:00Z'));
});

test('nextDueRem и nextDueShr принимают пояс; «сегодня» берётся из now (у общих — по поясу каждой стороны)', () => {
  const now = tzm.nowIn(AKL, new Date('2026-10-14T11:30:00Z')); // у них уже 15-е, 00:30
  assert.equal(now.date, '2026-10-15');
  const C = (o) => ({ id: hex(), date: '2026-10-14', slot: 'h07', text: 'x', on: true, sent: false, ...o });
  assert.equal(rem.nextDueRem({ custom: [C()], recurring: [] }, now, AKL), null, 'вчерашнее по их часам не считается');
  assert.equal(rem.nextDueRem({ custom: [C({ date: '2026-10-15' })], recurring: [] }, now, AKL), utc('2026-10-14T18:00:00Z'));
  const shr = { custom: [{ id: hex(), date: '2026-10-14', slot: 'h14', text: 'x', on: { a: true, b: true }, sent: { a: false, b: false } }], recurring: [] };
  const pin = Date.now;
  Date.now = () => utc('2026-10-14T11:30:00Z');
  try {
    assert.equal(rem.nextDueShr(shr, null, ['a', 'b'], { a: MSK, b: BER }), utc('2026-10-14T11:00:00Z'), 'ближайший из моментов сторон');
    assert.equal(rem.nextDueShr(shr, null, ['b'], { a: MSK, b: BER }), utc('2026-10-14T12:00:00Z'));
    assert.equal(rem.nextDueShr(shr, null, ['a', 'b'], { a: MSK, b: AKL }), utc('2026-10-14T11:00:00Z'), 'у стороны b (Окленд) 14-е уже прошло: считается только a');
    assert.equal(rem.nextDueShr(shr, null, ['b'], { a: MSK, b: AKL }), null);
  } finally { Date.now = pin; }
});

/* ---------- cron: время каждого аккаунта своё ---------- */
test('cron: каждому в его слот по его часам (Москва 14:30 — у берлинца 13:30, слот h14 ещё не наступил)', async (t) => {
  const calls = mockTg(t);
  pinMsk(t, 12, 0);
  const m = await mkLinked('moscow'), b = await mkLinked('berlin', BER);
  await addC(m.id, 'москвичу', 'h14'); await addC(b.id, 'берлинцу', 'h14');
  pinMsk(t, 14, 30);
  let r = await run();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(sent(calls), [[m.chat, '🔔 москвичу']]);
  assert.equal(scoreOf(m.id), null, 'у москвича отправлено: член убран');
  assert.equal(scoreOf(b.id), utc('2026-10-14T12:00:00Z'), 'у берлинца счёт остался на его слоте');
  pinMsk(t, 15, 30);
  r = await run();
  assert.deepEqual(sent(calls), [[m.chat, '🔔 москвичу'], [b.chat, '🔔 берлинцу']]);
  r = await run();
  assert.equal(sent(calls).length, 2, 'повторный запуск не дублирует');
});

test('cron: у окленда уже 15-е — вчерашнее не догоняется, завтрашнее придёт в 07:00 по его часам', async (t) => {
  const calls = mockTg(t);
  pinMsk(t, 14, 30); // Окленд 00:30 15-го
  const o = await mkLinked('auckland', AKL), m = await mkLinked('moscow');
  await addC(o.id, 'вчера', 'h07', '2026-10-14'); await addC(o.id, 'сегодня', 'h07', '2026-10-15'); await addC(m.id, 'москвичу 15-го', 'h07', '2026-10-15');
  assert.equal(scoreOf(o.id), utc('2026-10-14T18:00:00Z'), '07:00 15-го в Окленде (UTC+13) = 18:00 UTC 14-го; «вчерашнее» (14-е) в счёт не идёт');
  await run();
  assert.deepEqual(sent(calls), [], 'ещё рано, а «вчера» (14-е) у них уже прошло');
  pinMsk(t, 21, 30); // Окленд 07:30 15-го; у москвича ещё 14-е
  await run();
  assert.deepEqual(sent(calls), [[o.chat, '🔔 сегодня']]);
});

test('ручной слот: берёт аккаунты запада (Лос-Анджелес, 18:00 = 01:00 UTC следующих суток) и шлёт слот в их дату', async (t) => {
  const calls = mockTg(t);
  pinMsk(t, 14, 30); // Лос-Анджелес 04:30 14-го
  const l = await mkLinked('la', LAX), m = await mkLinked('moscow');
  await addC(l.id, 'вечер в LA', 'h18'); await addC(m.id, 'вечер в Москве', 'h18');
  assert.equal(scoreOf(l.id), utc('2026-10-15T01:00:00Z'));
  const r = await run({ slot: 'h18' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(sent(calls).map((x) => x[1]).sort(), ['🔔 вечер в LA', '🔔 вечер в Москве']);
});

test('сухой прогон с date: дата — у каждого аккаунта своя; ответ по Москве', async (t) => {
  pinMsk(t, 14, 30);
  const o = await mkLinked('auckland', AKL), m = await mkLinked('moscow');
  await addC(o.id, 'x', 'h07', '2026-10-15'); await addC(m.id, 'y', 'h07', '2026-10-15');
  const r = await run({ dry: '1', date: '2026-10-15' });
  assert.equal(r.body.would_send, 2);
  assert.equal(r.body.date, '2026-10-15');
  const r0 = await run({ dry: '1' });
  assert.deepEqual([r0.body.date, r0.body.hour], [TODAY, 14]);
});

/* ---------- общие напоминания пары ---------- */
async function mkPairLinked(tzA, tzB) {
  const a = await mkLinked('anna', tzA), b = await mkLinked('boris', tzB);
  const { token } = await acc.createPairToken(a.id);
  const r = await acc.joinPair(token, b.id);
  assert.equal(r.id, a.id);
  return { a, b, pm: 'p:' + acc.pairId(a.id, b.id) };
}

test('общее напоминание: «после 14:00» приходит каждому в 14:00 его пояса; счёт члена пары — ближайший из двух, затем уточняется', async (t) => {
  const calls = mockTg(t);
  pinMsk(t, 12, 0);
  const { a, b, pm } = await mkPairLinked(MSK, BER);
  const r = await post(custom, a.id, { date: TODAY, slot: 'h14', text: 'вместе', shared: true });
  assert.equal(r.statusCode, 200);
  assert.equal(scoreOf(pm), utc('2026-10-14T11:00:00Z'), 'у Москвы 14:00 = 11:00 UTC, у Берлина 12:00 UTC');
  pinMsk(t, 14, 30); // у Анны 14:30, у Бориса 13:30
  await run();
  assert.deepEqual(sent(calls), [[a.chat, '🔔 вместе']]);
  assert.equal(scoreOf(pm), utc('2026-10-14T12:00:00Z'), 'осталась сторона Бориса: счёт по его поясу');
  pinMsk(t, 15, 30);
  await run();
  assert.deepEqual(sent(calls), [[a.chat, '🔔 вместе'], [b.chat, '🔔 вместе']]);
  assert.equal(scoreOf(pm), null);
  await run();
  assert.equal(sent(calls).length, 2);
});

test('общее: дата и слот проверяются по часам обеих сторон (прошедшее у любой — 400), личное — по часам автора', async (t) => {
  pinMsk(t, 14, 30); // Москва 14:30, Берлин 13:30, Окленд 00:30 15-го
  const bm = await mkPairLinked(BER, MSK);
  assert.equal((await post(custom, bm.a.id, { date: TODAY, slot: 'h14', text: 'x', shared: true })).body.error, 'late', 'у Бориса в Москве 14:00 уже прошло');
  assert.equal((await post(custom, bm.b.id, { date: TODAY, slot: 'h14', text: 'x', shared: true })).body.error, 'late');
  assert.equal((await post(custom, bm.a.id, { date: TODAY, slot: 'h15', text: 'x', shared: true })).statusCode, 200);
  __reset(); setEnv(); process.env.TELEGRAM_BOT_TOKEN = 'test-token'; process.env.CRON_SECRET = 'test-cron-secret';
  const am = await mkPairLinked(AKL, MSK);
  const r = await post(custom, am.b.id, { date: TODAY, slot: 'h23', text: 'x', shared: true });
  assert.deepEqual([r.statusCode, r.body.error], [400, 'bad date'], 'у Анны в Окленде 14-е уже прошло');
  assert.equal((await post(custom, am.b.id, { date: '2026-10-15', slot: 'h23', text: 'x', shared: true })).statusCode, 200);
});

test('личное: слот «прошёл» по часам автора (берлинец в 13:30 ещё успевает на 14:00, москвич в 14:30 — нет); у окленда сегодня уже 15-е', async (t) => {
  pinMsk(t, 14, 30);
  const b = await mkLinked('berlin', BER), m = await mkLinked('moscow'), o = await mkLinked('auckland', AKL);
  assert.equal((await post(custom, b.id, { date: TODAY, slot: 'h14', text: 'x' })).statusCode, 200);
  assert.equal((await post(custom, m.id, { date: TODAY, slot: 'h14', text: 'x' })).body.error, 'late');
  assert.equal((await post(custom, o.id, { date: TODAY, slot: 'h23', text: 'x' })).body.error, 'bad date');
  assert.equal((await post(custom, o.id, { date: '2026-10-15', slot: 'h07', text: 'x' })).statusCode, 200);
  assert.equal((await post(custom, o.id, { date: '2026-10-15', slot: 'h00', text: 'x' })).statusCode, 400, 'слота h00 нет');
});

/* ---------- вид для сайта ---------- */
test('GET /api/reminders: next повторяющегося по «сегодня» смотрящего (Москва 14-е, Окленд 15-е)', async (t) => {
  pinMsk(t, 14, 30);
  const m = await mkLinked('moscow'), o = await mkLinked('auckland', AKL);
  for (const x of [m, o]) await rem.mutateRem(x.id, (r) => { r.recurring.push({ id: hex(), date: '2026-10-10', every: 'day', slot: 'h10', text: 'x', on: true, sent: {} }); });
  const res = async (id) => { const r = mockRes(); const q = mockReq({ method: 'GET', headers: { cookie: lib.makeCookie(id).split(';')[0] } }); await reminders(q, r); return r.body; };
  assert.equal((await res(m.id)).recurring[0].next, '2026-10-14');
  assert.equal((await res(o.id)).recurring[0].next, '2026-10-15');
});

/* ---------- смена пояса и перестройка ---------- */
async function setTzApi(id, tz) { return post(auth, id, { action: 'set-tz', tz }); }

test('set-tz: счёт привязанного аккаунта пересчитывается (раньше — понижается сразу; позже — лишний ранний счёт уточнит cron)', async (t) => {
  const calls = mockTg(t);
  pinMsk(t, 12, 0);
  const u = await mkLinked('anna');
  await addC(u.id, 'день', 'h14');
  assert.equal(scoreOf(u.id), utc('2026-10-14T11:00:00Z'));
  assert.equal((await setTzApi(u.id, TYO)).statusCode, 200);
  assert.equal(scoreOf(u.id), utc('2026-10-14T05:00:00Z'), 'Токио ближе к UTC на 6 часов: слот раньше');
  assert.equal((await setTzApi(u.id, BER)).statusCode, 200);
  assert.equal(scoreOf(u.id), utc('2026-10-14T05:00:00Z'), 'записи индекса только понижаются: прежний ранний счёт остаётся');
  pinMsk(t, 14, 30); // у берлинца 13:30
  const r = await run();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(sent(calls), [], 'cron разобрал ранний счёт, слать рано');
  assert.equal(scoreOf(u.id), utc('2026-10-14T12:00:00Z'), 'счёт уточнён по поясу Берлина');
});

test('set-tz без привязанного Telegram индекс не трогает; неизвестный пояс — 400', async (t) => {
  pinMsk(t, 12, 0);
  const id = await mkAccount(acc, 'plain');
  await rem.mutateRem(id, (r) => { r.custom.push({ id: hex(), date: TODAY, slot: 'h14', text: 'x', on: true, sent: false }); });
  __cmdLog(true);
  assert.equal((await setTzApi(id, BER)).statusCode, 200);
  assert.ok(!__cmdLog().some((c) => /dueq/.test(c) || /HMGET rem:/.test(c)), __cmdLog().join(' | '));
  assert.equal((await setTzApi(id, 'Mars/Base')).statusCode, 400);
});

test('перестройка индекса: счёт личных и общих по поясу каждой стороны', async (t) => {
  pinMsk(t, 12, 0);
  const { a, b, pm } = await mkPairLinked(MSK, BER);
  await rem.mutateRem(b.id, (r) => { r.custom.push({ id: hex(), date: TODAY, slot: 'h14', text: 'личное', on: true, sent: false }); }, { due: false, tz: BER });
  const tzs = rem.sideTzs(a.id, b.id, MSK, BER);
  await rem.mutateShr(a.id, b.id, (s) => { s.custom.push({ id: hex(), date: TODAY, slot: 'h15', text: 'общее', on: { a: true, b: true }, sent: { a: false, b: false } }); }, { due: false, tzs });
  assert.deepEqual(__zset('dueq'), []);
  const r = await rebuildDue();
  assert.equal(r.state, 'ok');
  assert.equal(scoreOf(b.id), utc('2026-10-14T12:00:00Z'), 'личное Бориса: 14:00 по Берлину');
  assert.equal(scoreOf(a.id), null);
  assert.equal(scoreOf(pm), utc('2026-10-14T12:00:00Z'), 'общее 15:00: у Москвы 12:00 UTC, у Берлина 13:00 UTC; ближайший — Москва');
});
