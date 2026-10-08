// Гостевой режим: парные части сайта и сервера должны давать одно и то же.
//   js/qr.js ↔ api/_qr.js (матрица QR до бита), js/local.js ↔ api/agent.js и api/wifi.js (проверка, ответы, `at`).
// local.js работает с localStorage и Response: localStorage подменяется заглушкой в памяти.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const sq = await import('../api/_qr.js');
const cq = await import('../js/qr.js');
const sa = await import('../api/agent.js');
const sw = await import('../api/wifi.js');
const local = await import('../js/local.js');

beforeEach(() => store.clear());

// Детерминированный генератор (mulberry32): прогон повторяется один в один.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ALPHA = 'abcXYZ019 ;,:"\\-_.@#/абвГДЕжзи世界😀é';
function rstr(rand, len, ascii = false) {
  const chars = [...(ascii ? ALPHA.slice(0, 20) : ALPHA)];
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * chars.length)];
  return s;
}
const call = async (m, u, b) => { const r = await local.guestApi(m, u, b); return { status: r.status, body: await r.json() }; };

test('QR: UTF-8 в байты как Buffer, в том числе непарные суррогаты', () => {
  const rand = rng(1);
  const cases = ['', 'a', 'Привет', '😀', '\ud800', 'a\udc00b', '\ud83d', '\ud83d\ude00\ud83d', 'WIFI:T:WPA;S:x;P:y;;'];
  for (let i = 0; i < 300; i++) cases.push(rstr(rand, Math.floor(rand() * 40)));
  for (const s of cases) assert.deepEqual(cq.utf8Bytes(s), [...Buffer.from(s, 'utf8')], JSON.stringify(s));
});

test('QR: матрица сайта совпадает с серверной на многих входах (версии 1–40)', () => {
  const rand = rng(2);
  const inputs = [];
  for (let n = 0; n <= 130; n++) inputs.push('x'.repeat(n));
  for (let n = 0; n < 300; n++) inputs.push(rstr(rand, Math.floor(rand() * 60)));
  for (let n = 131; n <= 2300; n += 53) inputs.push(rstr(rand, n, true)); // длинные только из однобайтовых символов, иначе не влезут
  for (const wifi of [
    { ssid: 'HomeNet', password: 'secret-pass-1', security: 'WPA', hidden: false },
    { ssid: 'Кафе №1', password: 'пароль;с:символами', security: 'WPA', hidden: true },
    { ssid: 'Open', password: '', security: 'nopass', hidden: false },
  ]) inputs.push(sw.wifiString(wifi));
  let versions = new Set();
  for (const s of inputs) {
    const a = cq.makeQr(s), b = sq.makeQr(s);
    assert.deepEqual(a, b, 'вход длиной ' + s.length);
    versions.add(a.size);
  }
  assert.ok(versions.size >= 30, 'покрыто версий: ' + versions.size);
  assert.ok(versions.has(177), 'есть версия 40');
});

test('QR: предел длины тот же, ошибка та же', () => {
  let last = 0;
  for (let n = 2300; n < 2400; n++) {
    let okS = true, okC = true;
    try { sq.makeQr('a'.repeat(n)); } catch (e) { okS = e instanceof RangeError; if (!okS) throw e; okS = false; }
    try { cq.makeQr('a'.repeat(n)); } catch (e) { if (!(e instanceof RangeError)) throw e; okC = false; }
    assert.equal(okC, okS, 'длина ' + n);
    if (okS) last = n;
  }
  assert.ok(last > 2300 && last < 2399, 'граница внутри диапазона: ' + last);
});

test('гостевой WiFi: ответы и проверка как у сервера', async () => {
  const rand = rng(3);
  const bodies = [
    { ssid: 'HomeNet', password: 'secret-pass-1', security: 'WPA', hidden: false },
    { ssid: 'Кафе №1', password: 'пароль;с:символами,и"кавычкой\\', security: 'WPA', hidden: true },
    { ssid: 'a', password: 'x'.repeat(64), security: 'WPA', hidden: false },
    { ssid: 'a', password: 'f'.repeat(64), security: 'WPA', hidden: false },
    { ssid: 'a', password: 'x'.repeat(8), security: 'WPA', hidden: false },
    { ssid: 'a', password: 'x'.repeat(7), security: 'WPA', hidden: false },
    { ssid: 'a', password: 'x'.repeat(63), security: 'WPA', hidden: false },
    { ssid: 'a', password: 'x'.repeat(65), security: 'WPA', hidden: false },
    { ssid: 'a', password: 'abcde', security: 'WEP', hidden: false },
    { ssid: 'a', password: 'abcdefghijklm', security: 'WEP', hidden: false },
    { ssid: 'a', password: '0123456789', security: 'WEP', hidden: false },
    { ssid: 'a', password: 'abcdefghij', security: 'WEP', hidden: false },
    { ssid: 'a', password: '0123456789abcdef0123456789', security: 'WEP', hidden: false },
    { ssid: 'a', password: 'secret', security: 'nopass', hidden: false },
    { ssid: 'a', security: 'nopass' },
    { ssid: 'Я'.repeat(16), password: 'secret-pass-1', security: 'WPA' },
    { ssid: 'Я'.repeat(17), password: 'secret-pass-1', security: 'WPA' },
    { ssid: 'x'.repeat(32), password: 'secret-pass-1', security: 'WPA' },
    { ssid: 'x'.repeat(33), password: 'secret-pass-1', security: 'WPA' },
    { ssid: '😀'.repeat(8), password: 'secret-pass-1', security: 'WPA' },
    { ssid: '😀'.repeat(9), password: 'secret-pass-1', security: 'WPA' },
    { ssid: '   ', password: 'secret-pass-1', security: 'WPA' },
    { ssid: '', password: 'secret-pass-1', security: 'WPA' },
    { ssid: 'a\nb', password: 'secret-pass-1', security: 'WPA' },
    { ssid: 'a\u007f', password: 'secret-pass-1', security: 'WPA' },
    { ssid: 'ok', password: 'secret\u0001pass', security: 'WPA' },
    { ssid: 'ok', password: 'secret-pass-1', security: 'WPA2' },
    { ssid: 'ok', password: 'secret-pass-1' },
    { ssid: 5, password: 'secret-pass-1', security: 'WPA' },
    { ssid: 'ok', password: 12345678, security: 'WPA' },
    { ssid: 'ok', password: 'secret-pass-1', security: 'WPA', hidden: 'true' },
    null, 'строка', 42, [],
  ];
  for (let i = 0; i < 150; i++) bodies.push({ ssid: rstr(rand, 1 + Math.floor(rand() * 20)), password: rstr(rand, Math.floor(rand() * 70)), security: ['WPA', 'WEP', 'nopass'][Math.floor(rand() * 3)], hidden: rand() < 0.5 });
  let ok = 0, bad = 0;
  for (const b of bodies) {
    store.clear();
    const want = sw.cleanWifi(b);
    const got = await call('PUT', '/api/wifi', b);
    if (want.cfg) {
      ok++;
      const c = want.cfg;
      assert.equal(got.status, 200, JSON.stringify(b));
      assert.deepEqual(got.body, { configured: true, ssid: c.ssid, password: c.password, security: c.security, hidden: c.hidden, qr: sq.makeQr(sw.wifiString(c)) }, JSON.stringify(b));
      assert.deepEqual((await call('GET', '/api/wifi')).body, got.body, 'GET отдаёт то же, что вернул PUT');
    } else {
      bad++;
      assert.equal(got.status, 400, JSON.stringify(b));
      assert.deepEqual(got.body, { error: want.error }, JSON.stringify(b));
      assert.deepEqual((await call('GET', '/api/wifi')).body, { configured: false }, 'неверные данные не записываются');
    }
  }
  assert.ok(ok > 40 && bad > 20, `верных ${ok}, неверных ${bad}`);
});

test('гостевой WiFi: GET без сети, DELETE, методы, битая запись, замена данными аккаунта', async () => {
  assert.deepEqual(await call('GET', '/api/wifi'), { status: 200, body: { configured: false } });
  assert.equal((await call('POST', '/api/wifi', {})).status, 405);
  const net = { ssid: 'HomeNet', password: 'secret-pass-1', security: 'WPA', hidden: false };
  assert.equal((await call('PUT', '/api/wifi', net)).status, 200);
  assert.deepEqual(await call('DELETE', '/api/wifi'), { status: 200, body: { configured: false } });
  assert.equal(store.has('g-wf'), false);
  store.set('g-wf', '{мусор');
  assert.deepEqual((await call('GET', '/api/wifi')).body, { configured: false }, 'битая запись = сети нет');
  store.set('g-wf', JSON.stringify({ ssid: 'x', password: 'short', security: 'WPA' }));
  assert.deepEqual((await call('GET', '/api/wifi')).body, { configured: false }, 'запись, не прошедшая проверку, не показывается');
  // данные аккаунта (с лишними полями) становятся гостевыми
  assert.equal(local.guestSetWf({ configured: true, ...net, qr: { size: 1, rows: ['1'] } }), true);
  assert.deepEqual(JSON.parse(store.get('g-wf')), net, 'лишние поля (qr, configured) не сохраняются');
  assert.equal(local.guestSetWf({ ssid: '', security: 'WPA', password: 'secret-pass-1' }), false);
  assert.deepEqual(JSON.parse(store.get('g-wf')), net, 'непрошедшие проверку данные ничего не меняют');
  assert.equal(local.guestSetWf(null), true);
  assert.equal(store.has('g-wf'), false, 'null — сети нет');
});

const ROWS = [
  { id: 'r1', app: 'Opera', h: 9, m: 30 },
  { id: 'r2', app: ' edge ', h: 7, m: 0, at: 123456 },
  { id: 'r3', app: 'Мой   клиент', h: null, m: null },
  { id: 'r4', app: 'constructor', h: 23, m: 50 },
  { id: 'r5', app: '__proto__', h: 1, m: 10 },
  { id: 'r6', app: 'toString', h: 2, m: 20 },
  { id: 'r7', app: 'a<b', h: 3, m: 30 },
  { id: 'r8', app: 'x'.repeat(40), h: 4, m: 40 },
  { id: 'r9', app: 'x'.repeat(41), h: 4, m: 40 },
  { id: 'r10', app: 'mozilla', h: 24, m: 10 },
  { id: 'r11', app: 'mozilla', h: 5, m: 15 },
  { id: 'r12', app: 'mozilla', h: 5 },
  { id: 'r1', app: 'app', h: 6, m: 10 },
  { id: 'BAD ID', app: 'app', h: null, m: null },
  { id: 7, app: 'app', h: 1.5, m: 10 },
  { app: 'app', h: '9', m: '10' },
  { id: 'r13', app: 5 },
  { id: 'r14' },
  null, 'строка', 5,
];

test('гостевой агент: проверка строк и `at` как у сервера', async (t) => {
  const NOW = Date.UTC(2026, 9, 8, 6, 0, 0); // 09:00 по Москве
  t.mock.method(Date, 'now', () => NOW);
  for (const take of [ROWS.slice(0, 3), ROWS.slice(3, 9), ROWS.slice(9, 12), ROWS.slice(12), ROWS.slice(0, 12), []]) {
    store.clear();
    const prev = sa.defaults();
    const want = sa.withAt(sa.cleanRows(take), prev, NOW);
    const got = await call('PUT', '/api/agent', { rows: take });
    assert.equal(got.status, 200);
    assert.equal(got.body.rows.length, want.length);
    for (let i = 0; i < want.length; i++) {
      const { id: _a, ...g } = got.body.rows[i];
      const { id: _b, ...w } = want[i];
      assert.deepEqual(g, w, 'строка ' + i + ' из ' + JSON.stringify(take.map((x) => x && x.app)));
      assert.match(got.body.rows[i].id, /^[a-z0-9]{1,16}$/);
    }
    assert.equal(new Set(got.body.rows.map((r) => r.id)).size, got.body.rows.length, 'id не повторяются');
    assert.deepEqual((await call('GET', '/api/agent')).body, got.body, 'GET отдаёт то же, что вернул PUT');
  }
});

test('гостевой агент: «constructor», «__proto__», «toString» остаются названиями', async () => {
  const r = await call('PUT', '/api/agent', { rows: [{ id: 'a', app: 'constructor' }, { id: 'b', app: '__proto__' }, { id: 'c', app: 'toString' }] });
  assert.deepEqual(r.body.rows.map((x) => x.app), ['constructor', '__proto__', 'toString']);
  assert.deepEqual(sa.cleanRows([{ app: 'constructor' }, { app: '__proto__' }, { app: 'toString' }]).map((x) => x.app), ['constructor', '__proto__', 'toString'], 'сервер так же');
});

test('гостевой агент: время одноразовое, `at` не двигается, пока ч:мин не менялись', async (t) => {
  let now = Date.UTC(2026, 9, 8, 6, 0, 0); // 09:00 МСК
  t.mock.method(Date, 'now', () => now);
  let rows = [{ id: 'a', app: 'app', h: 12, m: 30 }, { id: 'b', app: 'opera', h: 8, m: 0 }, { id: 'c', app: 'edge', h: null, m: null }];
  const first = (await call('PUT', '/api/agent', { rows })).body.rows;
  assert.equal(first[0].at, Date.UTC(2026, 9, 8, 9, 30), 'ближайшие 12:30 сегодня');
  assert.equal(first[1].at, Date.UTC(2026, 9, 9, 5, 0), '08:00 уже прошло: завтра');
  assert.equal(first[2].at, null);
  now += 4 * 3600e3; // 13:00: первый сброс прошёл
  const second = (await call('PUT', '/api/agent', { rows: first.map((r) => ({ ...r, at: 999 })) })).body.rows; // `at` от клиента игнорируется
  assert.deepEqual(second.map((r) => r.at), first.map((r) => r.at), 'прошедший сброс остаётся прошедшим');
  rows = [{ ...second[0], m: 40 }, second[1], second[2]];
  const third = (await call('PUT', '/api/agent', { rows })).body.rows;
  assert.equal(third[0].at, Date.UTC(2026, 9, 9, 9, 40), 'ч:мин изменились: новое ближайшее');
  assert.equal(third[1].at, second[1].at);
  // то же, что считает сервер
  assert.deepEqual(third, sa.withAt(sa.cleanRows(rows), second, now));
});

test('гостевой агент: лимит 12, неверное тело, методы, умолчания, битая запись, замена данными аккаунта', async () => {
  assert.deepEqual((await call('GET', '/api/agent')).body, { rows: sa.defaults() }, 'до первого сохранения четыре строки по умолчанию');
  const twelve = Array.from({ length: 12 }, (_, i) => ({ id: 'r' + i, app: 'app', h: null, m: null }));
  assert.equal((await call('PUT', '/api/agent', { rows: twelve })).status, 200);
  assert.deepEqual(await call('PUT', '/api/agent', { rows: twelve.concat([{ app: 'app' }]) }), { status: 400, body: { error: 'limit' } });
  for (const b of [null, {}, { rows: 'x' }, { rows: {} }, 'x']) assert.deepEqual(await call('PUT', '/api/agent', b), { status: 400, body: { error: 'bad request' } });
  assert.equal((await call('GET', '/api/agent')).body.rows.length, 12, 'отказ ничего не менял');
  assert.equal((await call('DELETE', '/api/agent')).status, 405);
  assert.deepEqual((await call('PUT', '/api/agent', { rows: [] })).body, { rows: [] });
  assert.deepEqual((await call('GET', '/api/agent')).body, { rows: [] }, 'пустой список сохраняется пустым, а не умолчаниями (как на сервере)');
  store.set('g-ag', '{мусор');
  assert.deepEqual((await call('GET', '/api/agent')).body, { rows: sa.defaults() });
  // данные аккаунта (с `at`) становятся гостевыми целиком, больше 12 строк обрезаются
  const acct = Array.from({ length: 14 }, (_, i) => ({ id: 'q' + i, app: 'opera', h: 10, m: 20, at: 1e12 + i }));
  assert.equal(local.guestSetAg(acct), true);
  const g = (await call('GET', '/api/agent')).body.rows;
  assert.equal(g.length, 12);
  assert.deepEqual(g[0], { id: 'q0', app: 'opera', h: 10, m: 20, at: 1e12 }, '`at` аккаунта сохраняется');
  assert.deepEqual(local.guestGetAg(), g);
});

test('гость: чужие пути отвечают 401, данные не смешиваются', async () => {
  for (const u of ['/api/reminders', '/api/tglink', '/api/auth', '/api/custom', '/api/wifi/x']) assert.equal((await call('GET', u)).status, 401, u);
  await call('PUT', '/api/wifi', { ssid: 'n', password: 'secret-pass-1', security: 'WPA' });
  await call('PUT', '/api/agent', { rows: [{ app: 'app', h: 1, m: 0 }] });
  assert.deepEqual([...store.keys()].sort(), ['g-ag', 'g-wf']);
});
