// Часовые пояса, часть 4: сайт. Парность js/tz.js ↔ api/_tz.js (и nextAt, retimeRows, monthWindow ↔ api/agent.js, api/_lib.js), js/time.js по поясу режима,
// список поясов (js/tzlist.js), гость (js/local.js: пояс устройства, g-tz, перенос времени при слиянии и выходе), `tz` в GET /api/data.
// Интерфейс в браузере здесь не проверяется (нет DOM): окно настроек, подсказка и main.js — по CHECKLIST.md.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset } from './redis.mjs';
import { mockReq, mockRes, setEnv, mkAccount } from './helpers.mjs';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
setEnv();
const stz = await import('../api/_tz.js');
const sa = await import('../api/agent.js');
const lib = await import('../api/_lib.js');
const acc = await import('../api/_acc.js');
const data = (await import('../api/data.js')).default;
const ctz = await import('../js/tz.js');
const time = await import('../js/time.js');
const tzl = await import('../js/tzlist.js');
const local = await import('../js/local.js');

beforeEach(() => { store.clear(); __reset(); setEnv(); time.useTz(null); });

const MSK = 'Europe/Moscow', BER = 'Europe/Berlin', LAX = 'America/Los_Angeles', TYO = 'Asia/Tokyo', KTM = 'Asia/Kathmandu', KOL = 'Asia/Kolkata';
const KIR = 'Pacific/Kiritimati', W12 = 'Etc/GMT+12', AKL = 'Pacific/Auckland', SYD = 'Australia/Sydney', UTC = 'UTC';
const ZONES = [MSK, BER, LAX, TYO, KTM, KOL, KIR, W12, AKL, SYD, UTC, 'America/St_Johns', 'Asia/Tehran', 'Pacific/Chatham', 'Australia/Lord_Howe', 'America/Sao_Paulo'];
const utc = (s) => Date.parse(s);
function pin(t, iso) {
  const real = Date.now.bind(Date), start = real(), base = Date.parse(iso);
  t.mock.method(Date, 'now', () => base + (real() - start));
}
// каждые 7 часов 13 минут за 400 суток: цепляет переходы на летнее время разных полушарий и все минуты
function* instants() { for (let ms = utc('2026-01-01T00:00:00Z'); ms < utc('2027-02-05T00:00:00Z'); ms += (7 * 60 + 13) * 60000) yield ms; }

/* ---------- парность js/tz.js и сервера ---------- */
test('js/tz.js ↔ api/_tz.js: cleanTz на хороших и плохих названиях', () => {
  for (const v of [...ZONES, 'UTC', ' Europe/Berlin ', 'Asia/Calcutta', 'Europe/Kiev', 'Europe/Kyiv', 'moscow', '+03:00', '', 'Europe', 'Europe/Nope', 'A/B/C/D', 'x'.repeat(70), null, undefined, 5, {}]) {
    assert.equal(ctz.cleanTz(v), stz.cleanTz(v), String(v));
  }
});

test('js/tz.js ↔ api/_tz.js: nowIn, offsetAt, zonedToMs на 400 суток по многим поясам', () => {
  for (const ms of instants()) {
    for (const z of ZONES) {
      assert.deepEqual(ctz.nowIn(z, new Date(ms)), stz.nowIn(z, new Date(ms)), z + ' ' + ms);
      assert.equal(ctz.offsetAt(ms, z), stz.offsetAt(ms, z), z + ' ' + ms);
    }
  }
  for (const z of ZONES) for (const date of ['2026-03-08', '2026-03-29', '2026-10-25', '2026-11-01', '2026-04-05', '2026-09-27', '2026-12-31']) {
    for (const mins of [0, 60, 150, 420, 1410, 1440]) assert.equal(ctz.zonedToMs(date, mins, z), stz.zonedToMs(date, mins, z), z + ' ' + date + ' ' + mins);
  }
  assert.equal(ctz.offsetAt(0), 3 * 3600e3, 'без пояса — Москва');
  assert.deepEqual(ctz.nowIn(undefined, new Date(0)), stz.nowIn(undefined, new Date(0)));
});

test('js/tz.js ↔ api/agent.js: nextAt и retimeRows', () => {
  let n = 0;
  for (const ms of instants()) {
    if (n++ % 5) continue;
    for (const z of [MSK, BER, LAX, KTM, KIR, AKL, SYD]) {
      for (const [h, m] of [[0, 0], [3, 10], [12, 0], [23, 50]]) assert.equal(ctz.nextAt(h, m, ms, z), sa.nextAt(h, m, ms, z), z + ' ' + ms + ' ' + h + ':' + m);
    }
    const rows = [{ id: 'a', app: 'app', h: 10, m: 0, at: ms + 3600e3 }, { id: 'b', app: 'opera', h: 15, m: 30, at: null }, { id: 'c', app: 'edge', h: null, m: null, at: null }];
    for (const [a, b] of [[MSK, BER], [BER, KTM], [LAX, TYO], [KIR, W12]]) {
      assert.deepEqual(ctz.retimeRows(rows, a, b, ms), sa.retimeRows(rows, a, b, ms), a + '→' + b + ' ' + ms);
    }
  }
  assert.equal(ctz.nextAt(10, 0, utc('2026-10-14T09:00:00Z')), sa.nextAt(10, 0, utc('2026-10-14T09:00:00Z')), 'без пояса — Москва');
});

test('js/tz.js ↔ api/_lib.js: monthWindow', () => {
  for (const ms of instants()) assert.deepEqual(ctz.monthWindow(ms), lib.monthWindow(ms), String(ms));
  assert.deepEqual(ctz.monthWindow(), lib.monthWindow());
});

test('sameTz и deviceTz', (t) => {
  assert.equal(ctz.sameTz('Asia/Kolkata', 'Asia/Calcutta'), true);
  assert.equal(ctz.sameTz(BER, MSK), false);
  assert.equal(ctz.sameTz(null, null), false);
  assert.equal(ctz.sameTz('bad', 'bad'), false);
  assert.equal(ctz.deviceTz(), stz.cleanTz(new Intl.DateTimeFormat().resolvedOptions().timeZone));
});

/* ---------- js/time.js ---------- */
test('time.js: clock и nowMins по поясу режима; без useTz — Москва', (t) => {
  pin(t, '2026-10-31T22:30:00Z'); // Москва 01:30 1 ноября; Берлин 23:30 31 октября; Лос-Анджелес 15:30; Кирибати 12:30 1 ноября
  assert.deepEqual(time.clock(), { cur: '2026-11', nxt: '2026-12', late: false, day: '2026-11-01' });
  assert.equal(time.nowMins(), 90);
  time.useTz(BER);
  assert.deepEqual(time.clock(), { cur: '2026-10', nxt: '2026-11', late: true, day: '2026-10-31' });
  assert.equal(time.nowMins(), 23 * 60 + 30);
  assert.equal(time.curTz(), BER);
  time.useTz(LAX);
  assert.equal(time.clock().day, '2026-10-31');
  assert.equal(time.nowMins(), 15 * 60 + 30);
  time.useTz(KIR);
  assert.equal(time.clock().cur, '2026-11');
  time.useTz(null);
  assert.equal(time.curTz(), MSK);
  assert.equal(time.clock().day, '2026-11-01');
});

test('time.js: декабрь — следующий месяц в январе', (t) => {
  pin(t, '2026-12-28T12:00:00Z');
  assert.deepEqual(time.clock(), { cur: '2026-12', nxt: '2027-01', late: true, day: '2026-12-28' });
});

/* ---------- список поясов ---------- */
test('tzlist: подписи смещений, названия, выбор', () => {
  const now = utc('2026-10-14T09:00:00Z');
  assert.equal(tzl.utcText(MSK, now), 'UTC+3');
  assert.equal(tzl.utcText(UTC, now), 'UTC');
  assert.equal(tzl.utcText(KTM, now), 'UTC+5:45');
  assert.equal(tzl.utcText(KOL, now), 'UTC+5:30');
  assert.equal(tzl.utcText(LAX, now), 'UTC-7');
  assert.equal(tzl.utcText(BER, now), 'UTC+2');
  assert.equal(tzl.utcText(BER, utc('2026-12-14T09:00:00Z')), 'UTC+1', 'зимнее время');
  assert.equal(tzl.tzName(MSK), 'Москва');
  assert.equal(tzl.tzName('Asia/Calcutta'), 'Индия (Дели)');
  assert.equal(tzl.tzName('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  assert.equal(tzl.tzShort(BER, now), 'Берлин, UTC+2');
});

test('tzlist: варианты по смещению, свои пояса добавляются, названия принимает сервер', () => {
  const now = utc('2026-10-14T09:00:00Z');
  const ch = tzl.tzChoices(MSK, null, now);
  assert.ok(ch.length > 40);
  const off = ch.map((c) => stz.offsetAt(now, c.id));
  assert.deepEqual(off, [...off].sort((a, b) => a - b), 'по возрастанию смещения');
  assert.ok(ch.every((c) => stz.cleanTz(c.id)), 'каждое название принимает сервер');
  assert.equal(new Set(ch.map((c) => stz.cleanTz(c.id))).size, ch.length, 'без повторов одного пояса');
  assert.equal(tzl.tzPick(ch, MSK), MSK);
  // пояса устройства и аккаунта вне списка добавляются; тот же пояс под другим названием не задваивается
  const more = tzl.tzChoices('Asia/Calcutta', 'America/Argentina/Buenos_Aires', now);
  assert.equal(more.length, ch.length + 1, 'Индия уже есть, Буэнос-Айрес новый');
  assert.ok(more.some((c) => /Buenos Aires/.test(c.t)));
  assert.equal(tzl.tzPick(more, 'Asia/Kolkata'), tzl.tzPick(more, 'Asia/Calcutta'));
  assert.notEqual(tzl.tzPick(more, 'Asia/Calcutta'), '');
  assert.equal(tzl.tzPick(more, 'Europe/Nope'), '');
  assert.equal(tzl.tzChoices('bad', 'bad', now).length, ch.length, 'негодные названия не добавляются');
});

/* ---------- гость ---------- */
const call = async (m, u, b) => { const r = await local.guestApi(m, u, b); return { status: r.status, body: await r.json() }; };
const putRows = (rows) => call('PUT', '/api/agent', { rows });

test('гость: PUT агента считает `at` по поясу устройства (useTz), без него — по Москве', async (t) => {
  pin(t, '2026-10-14T09:00:00Z'); // Москва 12:00, Берлин 11:00
  const row = [{ id: 'a', app: 'app', h: 13, m: 0 }];
  assert.equal((await putRows(row)).body.rows[0].at, utc('2026-10-14T10:00:00Z'));
  store.clear();
  time.useTz(BER);
  assert.equal((await putRows(row)).body.rows[0].at, utc('2026-10-14T11:00:00Z'));
  // перестановка/повтор без смены ч:мин `at` не двигает
  assert.equal((await putRows(row)).body.rows[0].at, utc('2026-10-14T11:00:00Z'));
});

test('гость ↔ сервер: withAt с поясом даёт то же', async (t) => {
  pin(t, '2026-10-14T09:00:00Z');
  for (const z of [MSK, BER, LAX, TYO, KTM, KIR]) {
    store.clear();
    time.useTz(z);
    const rows = [{ id: 'a', app: 'app', h: 13, m: 0 }, { id: 'o', app: 'opera', h: 2, m: 30 }, { id: 'e', app: 'edge', h: null, m: null }];
    const g = (await putRows(rows)).body.rows;
    const s = sa.withAt(sa.cleanRows(rows), [], Date.now(), z);
    assert.deepEqual(g, s, z);
  }
});

test('гость: метка g-tz. Нет метки — Москва; guestTzSync пересчитывает строки по `at` и ставит метку', async (t) => {
  pin(t, '2026-10-14T09:00:00Z');
  assert.equal(local.guestTzMark(), MSK);
  // старая запись (до поясов): 10:00 и 23:50 по Москве, метки нет
  const at1 = utc('2026-10-15T07:00:00Z'), at2 = utc('2026-10-14T20:50:00Z');
  store.set('g-ag', JSON.stringify({ rows: [{ id: 'a', app: 'app', h: 10, m: 0, at: at1 }, { id: 'o', app: 'opera', h: 23, m: 50, at: at2 }, { id: 'e', app: 'edge', h: null, m: null, at: null }] }));
  assert.equal(local.guestTzSync(MSK), false, 'пояс прежний: строки те же');
  assert.equal(store.get('g-tz'), MSK, 'метка поставлена');
  assert.equal(local.guestTzSync(BER), true);
  assert.equal(local.guestTzMark(), BER);
  let rows = local.guestGetAg();
  assert.deepEqual(rows.map((r) => [r.h, r.m, r.at]), [[9, 0, at1], [22, 50, at2], [null, null, null]]);
  assert.equal(local.guestTzSync(BER), false, 'повтор ничего не меняет');
  assert.equal(local.guestTzSync(TYO), true);
  rows = local.guestGetAg();
  assert.deepEqual(rows.map((r) => [r.h, r.m, r.at]), [[16, 0, at1], [5, 50, at2], [null, null, null]]);
  assert.equal(local.guestTzSync(MSK), true);
  assert.deepEqual(local.guestGetAg().map((r) => [r.h, r.m]), [[10, 0], [23, 50], [null, null]], 'обратно — исходное');
  assert.equal(local.guestTzSync('bad'), false, 'негодное название игнорируется');
  assert.equal(local.guestTzMark(), MSK);
});

test('гость: строка без `at` при смене пояса получает его по прежнему поясу', async (t) => {
  pin(t, '2026-10-14T09:00:00Z');
  store.set('g-ag', JSON.stringify({ rows: [{ id: 'a', app: 'app', h: 15, m: 30 }] }));
  local.guestTzSync(BER);
  const r = local.guestGetAg()[0];
  assert.deepEqual([r.h, r.m, r.at], [14, 30, utc('2026-10-14T12:30:00Z')]);
});

test('гость: без строк агента смена пояса только ставит метку; без записи данные не появляются', () => {
  assert.equal(local.guestTzSync(BER), false);
  assert.equal(store.get('g-tz'), BER);
  assert.equal(store.has('g-ag'), false);
});

test('гость: guestSetAg переносит время аккаунта в пояс устройства (`at` тот же), без поясов — как есть', (t) => {
  pin(t, '2026-10-14T09:00:00Z');
  const at = utc('2026-10-15T07:00:00Z');
  const rows = [{ id: 'a', app: 'app', h: 10, m: 0, at }];
  assert.equal(local.guestSetAg(rows, MSK, BER), true);
  assert.deepEqual(local.guestGetAg().map((r) => [r.h, r.m, r.at]), [[9, 0, at]]);
  assert.equal(local.guestTzMark(), BER, 'метка — пояс устройства');
  store.clear();
  assert.equal(local.guestSetAg(rows), true);
  assert.deepEqual(local.guestGetAg().map((r) => [r.h, r.m, r.at]), [[10, 0, at]]);
  assert.equal(store.has('g-tz'), false);
  store.clear();
  assert.equal(local.guestSetAg(rows, BER, BER), true, 'одинаковые пояса: без пересчёта');
  assert.deepEqual(local.guestGetAg().map((r) => [r.h, r.m]), [[10, 0]]);
});

test('слияние агента: время гостя переносится в пояс аккаунта по `at`', (t) => {
  pin(t, '2026-10-14T09:00:00Z');
  const at = utc('2026-10-15T07:00:00Z'); // 10:00 МСК = 09:00 Берлин
  const guest = [{ id: 'g1', app: 'app', h: 9, m: 0, at }, { id: 'g2', app: 'opera', h: 14, m: 30, at: null }];
  const acct = [{ id: 'a1', app: 'app', h: null, m: null, at: null }];
  // пояса не заданы: как раньше (время как есть)
  const plain = local.mergeAg(acct, guest);
  assert.deepEqual(plain.rows.map((r) => [r.app, r.h, r.m]), [['app', 9, 0], ['opera', 14, 30]]);
  // гость в Берлине, аккаунт в Москве: 09:00 Берлин = 10:00 Москва; строка без `at` считается по поясу гостя: 14:30 Берлин = 15:30 Москва
  const m = local.mergeAg(acct, guest, MSK, BER);
  assert.deepEqual(m.rows.map((r) => [r.app, r.h, r.m]), [['app', 10, 0], ['opera', 15, 30]]);
  assert.equal(m.changed, true);
  // пояса совпали: без пересчёта
  assert.deepEqual(local.mergeAg(acct, guest, BER, BER).rows.map((r) => [r.app, r.h, r.m]), [['app', 9, 0], ['opera', 14, 30]]);
  // у аккаунта время уже есть: побеждает аккаунт, время гостя не нужно
  const both = local.mergeAg([{ id: 'a1', app: 'app', h: 7, m: 10, at: null }], guest, MSK, BER);
  assert.deepEqual(both.rows.map((r) => [r.app, r.h, r.m]), [['app', 7, 10], ['opera', 15, 30]]);
});

test('гость: окно новых месяцев то же, что у сервера (с запасом на все пояса)', async (t) => {
  pin(t, '2026-10-31T10:30:00Z'); // на Кирибати уже ноябрь, окно до января 2027
  const put = (k) => call('PUT', '/api/data', { parts: { [k]: { base: 0, value: [] } } });
  for (const k of ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01']) assert.equal((await put(k)).status, 200, k);
  for (const k of ['2026-08', '2027-02']) assert.equal((await put(k)).status, 400, k);
});

test('слияние кэшбэка: месяц вне окна сервера пропускается, в окне — копируется', (t) => {
  pin(t, '2026-10-31T10:30:00Z');
  const blk = (bank) => [{ bank, items: [{ cat: 'Супермаркеты', pct: '5' }] }];
  const gst = { custom: [], months: { '2027-01': blk('sber'), '2027-02': blk('sber') } };
  const m = local.mergeCb({ custom: [], months: {} }, gst);
  assert.deepEqual(Object.keys(m.data.months), ['2027-01']);
  assert.deepEqual(m.parts, ['2027-01']);
});

/* ---------- сервер: пояс в GET /api/data ---------- */
test('GET /api/data: tz и tzSet — по умолчанию Москва без метки, после выбора пояс аккаунта', async () => {
  const id = await mkAccount(acc, 'tzget');
  const get = async () => {
    const res = mockRes();
    const req = mockReq({ method: 'GET', headers: { cookie: lib.makeCookie(id).split(';')[0] } });
    req.query = {};
    await data(req, res);
    return res.body;
  };
  assert.deepEqual([(await get()).tz, (await get()).tzSet], [MSK, false]);
  await acc.setTz(id, BER);
  assert.deepEqual([(await get()).tz, (await get()).tzSet], [BER, true]);
  await acc.setTz(id, null);
  assert.deepEqual([(await get()).tz, (await get()).tzSet], [MSK, false]);
});
