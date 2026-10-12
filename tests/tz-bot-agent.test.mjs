// Часовые пояса, часть 3: месяц кэшбэка в боте по поясу аккаунта, окно новых месяцев PUT /api/data (±14 часов), агент (nextAt по поясу, `at` абсолютный,
// пересчёт ч:мин при смене пояса). Время подменяется (pin). Москва UTC+3, Берлин +2 до 2026-10-25 и +1 после, Токио +9, Лос-Анджелес −7, Катманду +5:45, Кирибати +14.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __cmdLog, __fail } from './redis.mjs';
import { mockReq, mockRes, setEnv, mkAccount, linkUser, mockTg } from './helpers.mjs';

setEnv();
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
const lib = await import('../api/_lib.js');
const acc = await import('../api/_acc.js');
const bot = await import('../api/_bot.js');
const agentMod = await import('../api/agent.js');
const auth = (await import('../api/auth.js')).default;
const data = (await import('../api/data.js')).default;
const tgHandler = (await import('../api/telegram.js')).default;
const { nowIn } = await import('../api/_tz.js');

beforeEach(() => { __reset(); setEnv(); process.env.TELEGRAM_BOT_TOKEN = 'test-token'; });

const BER = 'Europe/Berlin', MSK = 'Europe/Moscow', LAX = 'America/Los_Angeles', TYO = 'Asia/Tokyo', KTM = 'Asia/Kathmandu', KOL = 'Asia/Kolkata';
const KIR = 'Pacific/Kiritimati', W12 = 'Etc/GMT+12', AKL = 'Pacific/Auckland';
const utc = (s) => Date.parse(s);
// Время идёт как настоящее от заданного момента (иначе таймауты и счётчики внутри кода не двигались бы).
function pin(t, iso) {
  const real = Date.now.bind(Date), start = real(), base = Date.parse(iso);
  t.mock.method(Date, 'now', () => base + (real() - start));
}
async function call(h, method, id, body) {
  const res = mockRes();
  const req = mockReq({ method, headers: { cookie: lib.makeCookie(id).split(';')[0], ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body });
  req.query = {};
  await h(req, res);
  return res;
}
const setTzApi = (id, tz) => call(auth, 'POST', id, { action: 'set-tz', tz });
const putAgent = (id, rows) => call(agentMod.default, 'PUT', id, { rows });
const getAgent = async (id) => (await call(agentMod.default, 'GET', id)).body.rows;

/* ---------- окно новых месяцев ---------- */
test('monthWindow: «прошлый» по часам UTC−12, «+2» по часам UTC+14; смена года', () => {
  const w = (iso) => lib.monthWindow(utc(iso));
  assert.deepEqual(w('2026-10-15T12:00:00Z'), { lo: '2026-09', hi: '2026-12' }, 'середина месяца: обычное окно');
  assert.deepEqual(w('2026-10-31T09:00:00Z'), { lo: '2026-09', hi: '2026-12' }, 'на Кирибати ещё 31 октября 23:00');
  assert.deepEqual(w('2026-10-31T10:00:00Z'), { lo: '2026-09', hi: '2027-01' }, 'на Кирибати уже ноябрь: +2 даёт январь');
  assert.deepEqual(w('2026-11-01T11:59:00Z'), { lo: '2026-09', hi: '2027-01' }, 'на UTC−12 ещё 31 октября: «прошлый» считается от октября');
  assert.deepEqual(w('2026-11-01T12:00:00Z'), { lo: '2026-10', hi: '2027-01' }, 'и на UTC−12 наступил ноябрь');
  assert.deepEqual(w('2026-12-31T12:00:00Z'), { lo: '2026-11', hi: '2027-03' }, 'через границу года');
  assert.deepEqual(lib.monthWindow(), lib.monthWindow(Date.now()), 'без аргумента — по Date.now');
});

test('monthWindow накрывает «прошлый … +2» любого пояса в любой момент года', () => {
  const zones = [MSK, BER, LAX, TYO, KTM, KOL, KIR, W12, AKL, 'UTC', 'Pacific/Pago_Pago', 'Pacific/Apia', 'America/St_Johns'];
  for (let ms = utc('2026-01-01T00:00:00Z'); ms < utc('2027-01-02T00:00:00Z'); ms += 3 * 3600e3) {
    const { lo, hi } = lib.monthWindow(ms);
    for (const z of zones) {
      const cur = nowIn(z, new Date(ms)).month;
      const a = lib.shiftMonth(cur, -1), b = lib.shiftMonth(cur, 2);
      assert.ok(a >= lo && b <= hi, z + ' ' + new Date(ms).toISOString() + ': ' + a + '…' + b + ' вне ' + lo + '…' + hi);
    }
  }
});

test('curMonth(tz): по поясу, без аргумента Москва', (t) => {
  pin(t, '2026-10-31T22:30:00Z'); // Москва 01:30 1 ноября, Лос-Анджелес 15:30 31 октября
  assert.equal(lib.curMonth(), '2026-11');
  assert.equal(lib.curMonth(MSK), '2026-11');
  assert.equal(lib.curMonth(LAX), '2026-10');
});

test('PUT /api/data: новый месяц принимается в окне всех поясов, за его краем — 400; не зависит от пояса аккаунта', async (t) => {
  pin(t, '2026-10-31T10:30:00Z'); // Москва 13:30 31 октября; на Кирибати 00:30 1 ноября; на UTC−12 ещё 30 октября
  const mk = async (name, tz) => { const id = await mkAccount(acc, name); if (tz) await acc.setTz(id, tz); return id; };
  const put = (id, k) => call(data, 'PUT', id, { parts: { [k]: { base: 0, value: [] } } });
  for (const tz of [null, MSK, KIR, W12]) {
    const id = await mk('w' + (tz || 'none').replace(/\W/g, ''), tz);
    for (const k of ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01']) assert.equal((await put(id, k)).statusCode, 200, (tz || 'без пояса') + ' ' + k);
    for (const k of ['2026-08', '2027-02']) assert.equal((await put(id, k)).statusCode, 400, (tz || 'без пояса') + ' ' + k);
  }
});

test('PUT /api/data не читает запись аккаунта (расход команд прежний)', async (t) => {
  pin(t, '2026-10-15T10:00:00Z');
  const id = await mkAccount(acc, 'cmds');
  __cmdLog(true);
  assert.equal((await call(data, 'PUT', id, { parts: { '2026-10': { base: 0, value: [] } } })).statusCode, 200);
  assert.ok(!__cmdLog().some((c) => /^GET acc:/.test(c)), __cmdLog().join(' | '));
});

/* ---------- бот: месяц по поясу аккаунта ---------- */
async function send(from, text) {
  const res = mockRes();
  await tgHandler(mockReq({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': bot.webhookSecret() }, body: { update_id: 1, message: { message_id: 5, from, chat: { id: from.id * 100 + 1, type: 'private' }, text } } }), res);
  assert.equal(res.statusCode, 200);
}
const DOC = () => ({ custom: [], rev: {}, months: {
  '2026-10': [{ bank: 'otp', items: [{ cat: 'Супермаркеты', pct: '5' }] }],
  '2026-11': [{ bank: 'sber', items: [{ cat: 'Супермаркеты', pct: '10' }] }],
} });
const texts = (calls) => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text);

test('бот: «Пятёрочка» отвечает по месяцу пояса аккаунта (Москва ещё октябрь, Кирибати уже ноябрь)', async (t) => {
  const calls = mockTg(t);
  pin(t, '2026-10-31T10:30:00Z');
  const m = await linkUser(acc, 'msk', { id: 11, username: 'msk' });
  const k = await linkUser(acc, 'kir', { id: 12, username: 'kir' });
  await acc.setTz(k, KIR);
  await lib.writeDoc(m, DOC(), null);
  await lib.writeDoc(k, DOC(), null);
  await send({ id: 11, username: 'msk' }, 'Пятёрочка');
  await send({ id: 12, username: 'kir' }, 'Пятёрочка');
  const [a, b] = texts(calls);
  assert.match(a, /5% — ОТП/, 'Москва: октябрь');
  assert.match(b, /10% — Сбер/, 'Кирибати: ноябрь');
  assert.ok(!/ОТП/.test(b) && !/Сбер/.test(a));
});

test('бот: /cashback — заголовок и «следующий месяц» от месяца пояса аккаунта', async (t) => {
  const calls = mockTg(t);
  pin(t, '2026-10-31T10:30:00Z');
  const m = await linkUser(acc, 'msk2', { id: 21, username: 'msk2' });
  const k = await linkUser(acc, 'kir2', { id: 22, username: 'kir2' });
  await acc.setTz(k, KIR);
  await lib.writeDoc(m, DOC(), null);
  await lib.writeDoc(k, DOC(), null);
  await send({ id: 21, username: 'msk2' }, '/cashback');
  const msk = texts(calls).splice(0);
  assert.equal(msk.length, 2, 'Москва: октябрь и заполненный ноябрь');
  assert.match(msk[0], /^Кэшбэки, Октябрь 2026/);
  assert.match(msk[1], /^Кэшбэки, Ноябрь 2026/);
  calls.length = 0;
  await send({ id: 22, username: 'kir2' }, '/cashback');
  const kir = texts(calls);
  assert.equal(kir.length, 1, 'Кирибати: ноябрь, пустой декабрь не показывается; октября уже нет');
  assert.match(kir[0], /^Кэшбэки, Ноябрь 2026/);
});

test('бот: у не соединённого аккаунта +1 команда (запись аккаунта за поясом), у соединённого столько же, сколько было', async (t) => {
  mockTg(t);
  pin(t, '2026-10-15T10:00:00Z');
  const u = await linkUser(acc, 'solo', { id: 31, username: 'solo' });
  await lib.writeDoc(u, DOC(), null);
  __cmdLog(true);
  await send({ id: 31, username: 'solo' }, 'Пятёрочка');
  const gets = __cmdLog().filter((c) => /^GET acc:/.test(c));
  assert.equal(gets.length, 1, __cmdLog().join(' | '));
});

/* ---------- агент ---------- */
test('nextAt: ближайшее время по поясу; наступившее — завтра по календарю пояса', () => {
  const now = utc('2026-10-14T09:00:00Z'); // Москва 12:00, Берлин 11:00, Токио 18:00, Лос-Анджелес 02:00
  assert.equal(agentMod.nextAt(13, 0, now), utc('2026-10-14T10:00:00Z'), 'без пояса Москва');
  assert.equal(agentMod.nextAt(12, 0, now), utc('2026-10-15T09:00:00Z'), 'Москва: наступает сейчас — завтра');
  assert.equal(agentMod.nextAt(13, 0, now, BER), utc('2026-10-14T11:00:00Z'));
  assert.equal(agentMod.nextAt(11, 0, now, BER), utc('2026-10-15T09:00:00Z'), 'Берлин: 11:00 наступает сейчас — завтра');
  assert.equal(agentMod.nextAt(2, 30, now, TYO), utc('2026-10-14T17:30:00Z'));
  assert.equal(agentMod.nextAt(1, 0, now, LAX), utc('2026-10-15T08:00:00Z'), 'Лос-Анджелес: 01:00 уже прошло');
  assert.equal(agentMod.nextAt(23, 50, now, KTM), utc('2026-10-14T18:05:00Z'), 'Катманду +5:45');
  assert.equal(agentMod.nextAt(10, 0, now, AKL), utc('2026-10-14T21:00:00Z'), 'Окленд (UTC+13): сейчас 22:00, 10:00 сегодня прошло — завтра 10:00');
});

test('nextAt: «завтра» не равно «+24 часа» в день перехода на зимнее время (Берлин, 2026-10-25)', () => {
  const now = utc('2026-10-24T22:30:00Z'); // 00:30 CEST 25 октября
  assert.equal(agentMod.nextAt(0, 0, now, BER), utc('2026-10-25T23:00:00Z'), '00:00 26 октября по CET');
  assert.equal(agentMod.nextAt(1, 0, now, BER), utc('2026-10-24T23:00:00Z'), '01:00 CEST сегодня ещё впереди');
});

test('nextAt и withAt: по умолчанию Москва, результат прежний (парная проверка гостя опирается на это)', () => {
  for (const now of [utc('2026-10-14T09:00:00Z'), utc('2026-12-31T20:59:00Z'), utc('2026-03-01T00:00:00Z')]) {
    for (const [h, m] of [[0, 0], [12, 0], [23, 50], [3, 10]]) {
      const d = new Date(now + 3 * 3600e3);
      const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m) - 3 * 3600e3;
      assert.equal(agentMod.nextAt(h, m, now), at <= now ? at + 864e5 : at);
    }
  }
  const rows = agentMod.cleanRows([{ id: 'a', app: 'app', h: 13, m: 0 }]);
  assert.equal(agentMod.withAt(rows, [], utc('2026-10-14T09:00:00Z'))[0].at, utc('2026-10-14T10:00:00Z'));
  assert.equal(agentMod.withAt(rows, [], utc('2026-10-14T09:00:00Z'), BER)[0].at, utc('2026-10-14T11:00:00Z'));
});

test('retimeRows: `at` тот же, ч:мин по новому поясу; без времени не трогает; без `at` считает по старому поясу', () => {
  const now = utc('2026-10-14T09:00:00Z');
  const at = utc('2026-10-15T07:00:00Z'); // 10:00 по Москве
  const rows = [
    { id: 'a', app: 'app', h: 10, m: 0, at },
    { id: 'b', app: 'opera', h: null, m: null, at: null },
    { id: 'c', app: 'edge', h: 15, m: 30, at: null }, // старая строка без `at`: 15:30 по Москве → 12:30Z
  ];
  const ber = agentMod.retimeRows(rows, MSK, BER, now);
  assert.deepEqual(ber[0], { id: 'a', app: 'app', h: 9, m: 0, at });
  assert.deepEqual(ber[1], rows[1]);
  assert.deepEqual(ber[2], { id: 'c', app: 'edge', h: 14, m: 30, at: utc('2026-10-14T12:30:00Z') });
  const kol = agentMod.retimeRows([rows[0]], MSK, KOL, now);
  assert.deepEqual([kol[0].h, kol[0].m, kol[0].at], [12, 30, at], 'Индия +5:30: 12:30');
  const ktm = agentMod.retimeRows([rows[0]], MSK, KTM, now);
  assert.deepEqual([ktm[0].h, ktm[0].m, ktm[0].at], [12, 40, at], 'Катманду +5:45: 12:45 округляется вниз до сетки 10 минут, `at` точный');
  assert.deepEqual(agentMod.retimeRows(ber, BER, MSK, now).map((r) => [r.h, r.m, r.at]), [[10, 0, at], [null, null, null], [15, 30, utc('2026-10-14T12:30:00Z')]], 'обратно — исходное');
});

test('PUT агента: `at` по поясу аккаунта; перестановка без смены времени аккаунт не читает', async (t) => {
  pin(t, '2026-10-14T09:00:00Z'); // Москва 12:00, Берлин 11:00
  const m = await mkAccount(acc, 'agm'), b = await mkAccount(acc, 'agb');
  await acc.setTz(b, BER);
  const rows = [{ id: 'a', app: 'app', h: 13, m: 0 }, { id: 'o', app: 'opera', h: null, m: null }];
  assert.equal((await putAgent(m, rows)).body.rows[0].at, utc('2026-10-14T10:00:00Z'));
  const rb = await putAgent(b, rows);
  assert.equal(rb.body.rows[0].at, utc('2026-10-14T11:00:00Z'));
  __cmdLog(true);
  const re = await putAgent(b, [rb.body.rows[1], rb.body.rows[0]]); // перестановка
  assert.equal(re.statusCode, 200);
  assert.equal(re.body.rows[1].at, utc('2026-10-14T11:00:00Z'), '`at` не двигается');
  assert.ok(!__cmdLog().some((c) => /^GET acc:/.test(c)), __cmdLog().join(' | '));
  __cmdLog(true);
  await putAgent(b, [{ ...rb.body.rows[0], m: 10 }]); // время изменилось: нужен пояс
  assert.equal(__cmdLog().filter((c) => /^GET acc:/.test(c)).length, 1);
});

test('set-tz: `at` остаётся, ч:мин строк пересчитываются; повторный и тот же пояс ничего не пишут; сброс — обратно в Москву', async (t) => {
  pin(t, '2026-10-14T09:00:00Z');
  const id = await mkAccount(acc, 'retime');
  const put = (await putAgent(id, [{ id: 'a', app: 'app', h: 10, m: 0 }, { id: 'o', app: 'opera', h: 23, m: 50 }, { id: 'e', app: 'edge', h: null, m: null }])).body.rows;
  const ats = put.map((r) => r.at);
  assert.equal(ats[0], utc('2026-10-15T07:00:00Z'), '10:00 МСК уже прошло сегодня: завтра');
  assert.equal(ats[1], utc('2026-10-14T20:50:00Z'));
  assert.equal((await setTzApi(id, BER)).statusCode, 200);
  let rows = await getAgent(id);
  assert.deepEqual(rows.map((r) => [r.h, r.m, r.at]), [[9, 0, ats[0]], [22, 50, ats[1]], [null, null, null]], 'Берлин на час позади');
  // клиент возвращает те же строки (автосохранение): `at` не двигается
  assert.deepEqual((await putAgent(id, rows)).body.rows.map((r) => r.at), ats);
  // тот же пояс: записи нет
  __cmdLog(true);
  assert.equal((await setTzApi(id, BER)).statusCode, 200);
  assert.ok(!__cmdLog().some((c) => /SET agent:|EVAL.*agent:/.test(c)), __cmdLog().join(' | '));
  assert.equal((await setTzApi(id, TYO)).statusCode, 200);
  rows = await getAgent(id);
  assert.deepEqual(rows.map((r) => [r.h, r.m, r.at]), [[16, 0, ats[0]], [5, 50, ats[1]], [null, null, null]], 'Токио +9: 23:50 МСК = 05:50 следующего дня');
  assert.equal((await setTzApi(id, '')).statusCode, 200);
  rows = await getAgent(id);
  assert.deepEqual(rows.map((r) => [r.h, r.m, r.at]), [[10, 0, ats[0]], [23, 50, ats[1]], [null, null, null]], 'сброс = Москва, исходные ч:мин');
});

test('set-tz: строка без `at` (старая запись) получает его по прежнему поясу; нет записи агента — ничего не создаётся', async (t) => {
  pin(t, '2026-10-14T09:00:00Z');
  const id = await mkAccount(acc, 'old');
  await lib.writeRec('agent', id, { rows: [{ id: 'a', app: 'app', h: 15, m: 30 }] }, null); // без `at`, как до появления поля
  assert.equal((await setTzApi(id, BER)).statusCode, 200);
  const r = (await getAgent(id))[0];
  assert.deepEqual([r.h, r.m, r.at], [14, 30, utc('2026-10-14T12:30:00Z')]);
  const other = await mkAccount(acc, 'norec');
  assert.equal((await setTzApi(other, BER)).statusCode, 200);
  assert.equal((await lib.readRec('agent', other)).raw, null, 'записи агента не появилось');
  assert.deepEqual((await call(agentMod.default, 'GET', other)).body.rows, agentMod.defaults());
});

test('set-tz: пояс со смещением вне сетки 10 минут (Катманду): `at` точный, минуты округлены вниз, PUT его не двигает', async (t) => {
  pin(t, '2026-10-14T09:00:00Z');
  const id = await mkAccount(acc, 'ktm');
  const at = (await putAgent(id, [{ id: 'a', app: 'app', h: 10, m: 0 }])).body.rows[0].at;
  assert.equal((await setTzApi(id, KTM)).statusCode, 200);
  const r = (await getAgent(id))[0];
  assert.deepEqual([r.h, r.m, r.at], [12, 40, at]);
  assert.equal((await putAgent(id, [r])).body.rows[0].at, at, 'ч:мин не менялись: `at` прежний');
});

test('set-tz: сбой пересчёта агента не отменяет смену пояса', async (t) => {
  pin(t, '2026-10-14T09:00:00Z');
  const id = await mkAccount(acc, 'fail');
  await putAgent(id, [{ id: 'a', app: 'app', h: 10, m: 0 }]);
  const err = t.mock.method(console, 'error', () => {});
  __fail('write', 'agent:'); // запись агента не проходит (сбой Redis только на ключе agent:)
  const r = await setTzApi(id, BER);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { tz: BER, tzSet: true });
  assert.ok(err.mock.calls.some((c) => /auth tz agent/.test(String(c.arguments[0]))), 'причина записана в журнал');
});

test('кэшбэк и агент: пояс аккаунта не влияет на чужие данные', async (t) => {
  pin(t, '2026-10-14T09:00:00Z');
  const a = await mkAccount(acc, 'iso1'), b = await mkAccount(acc, 'iso2');
  await putAgent(a, [{ id: 'a', app: 'app', h: 10, m: 0 }]);
  await putAgent(b, [{ id: 'a', app: 'app', h: 10, m: 0 }]);
  await setTzApi(a, TYO);
  assert.deepEqual((await getAgent(b)).map((r) => [r.h, r.m]), [[10, 0]]);
  assert.deepEqual((await getAgent(a)).map((r) => [r.h, r.m]), [[16, 0]]);
});
