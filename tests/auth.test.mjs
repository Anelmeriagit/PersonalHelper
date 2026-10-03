// Аккаунты и вход: api/_lib.js (сессия), api/_acc.js, api/auth.js на заглушке Redis.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __keys, __raw, __fail } from './redis.mjs';
import { mockReq, mockRes, setEnv, fakeClock } from './helpers.mjs';

setEnv();
const lib = await import('../api/_lib.js');
const auth = (await import('../api/auth.js')).default;

beforeEach(() => { __reset(); setEnv(); process.env.REG_OPEN = '1'; });

const DAY = 864e5, PASS = 'correct-horse';
const cookieOf = (res) => String(res.headers['set-cookie']).split(';')[0];
const reqWith = (res) => ({ headers: { cookie: cookieOf(res) } });
async function post(body, { ip = '10.0.0.1' } = {}) {
  const res = mockRes();
  await auth(mockReq({ method: 'POST', headers: { 'x-real-ip': ip }, body }), res);
  return res;
}
const reg = (user, pass = PASS, o) => post({ action: 'register', user, pass }, o);
const login = (user, pass = PASS, o) => post({ action: 'login', user, pass }, o);
const accKeys = () => __keys().filter((k) => k.startsWith('acc:'));
const ID = /^[0-9a-f]{32}$/;

/* ---------- сессия ---------- */
test('cookie: флаги и круг «выдали → прочитали» по id', () => {
  const id = 'a'.repeat(32);
  const c = lib.makeCookie(id);
  assert.match(c, /^cb_session=[^;]+\.[^;]+;/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(c.includes(flag), flag);
  assert.equal(lib.session({ headers: { cookie: c.split(';')[0] } }), id);
});

test('cookie: подделка, мусор, не-id в имени пользователя не принимаются', () => {
  const id = 'b'.repeat(32);
  const [name, rest] = lib.makeCookie(id).split(';')[0].split('=');
  const [p, s] = rest.split('.');
  const flip = (str) => str.slice(0, -1) + (str.endsWith('A') ? 'B' : 'A');
  const sess = (v) => lib.session({ headers: { cookie: v } });
  assert.equal(sess(`${name}=${p}.${flip(s)}`), null);
  assert.equal(sess(`${name}=${flip(p)}.${s}`), null);
  assert.equal(sess(`${name}=garbage`), null);
  assert.equal(lib.session({ headers: {} }), null);
  assert.equal(sess(lib.makeCookie('Test').split(';')[0]), null, 'подписанная cookie с не-id отвергается');
});

test('cookie: 30 дней, SESSION_VERSION, продление после 7 дней', (t) => {
  const id = 'c'.repeat(32);
  const c = lib.makeCookie(id).split(';')[0];
  const clock = fakeClock(t);
  clock.advance(6 * DAY);
  assert.equal(lib.renewCookie({ headers: { cookie: c } }), null);
  clock.advance(2 * DAY);
  assert.match(lib.renewCookie({ headers: { cookie: c } }), /^cb_session=/);
  clock.advance(22 * DAY);
  assert.equal(lib.session({ headers: { cookie: c } }), null, 'истекла');
  process.env.SESSION_VERSION = '2';
  const fresh = lib.makeCookie(id).split(';')[0];
  process.env.SESSION_VERSION = '3';
  assert.equal(lib.session({ headers: { cookie: fresh } }), null, 'смена версии разлогинивает');
});

test('без SESSION_SECRET сессий нет и cookie не выдаётся', () => {
  const id = 'd'.repeat(32);
  const c = lib.makeCookie(id).split(';')[0];
  delete process.env.SESSION_SECRET;
  assert.equal(lib.session({ headers: { cookie: c } }), null);
  assert.throws(() => lib.makeCookie(id), /SESSION_SECRET/);
});

/* ---------- регистрация ---------- */
test('регистрация закрыта, пока REG_OPEN не равен 1: 403 и ничего не записано', async () => {
  delete process.env.REG_OPEN;
  const r = await reg('anna');
  assert.equal(r.statusCode, 403);
  assert.deepEqual(__keys(), []);
  process.env.REG_OPEN = '0';
  assert.equal((await reg('anna')).statusCode, 403);
});

test('регистрация: аккаунт создан, cookie ведёт на него, пароль в базе только как scrypt-хэш', async () => {
  const r = await reg('  Anna_K ', 'пароль-Ё 123');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true });
  const id = lib.session(reqWith(r));
  assert.match(id, ID);
  assert.equal(__raw('nick:anna_k'), id);
  const acc = JSON.parse(__raw('acc:' + id));
  assert.equal(acc.nick, 'anna_k');
  assert.match(acc.pw, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.equal(__raw('users'), '1');
  const dump = JSON.stringify(__keys().map((k) => __raw(k)));
  assert.ok(!dump.includes('пароль-Ё'), 'пароль не должен лежать в базе открытым текстом');
  const l = await login('ANNA_K', 'пароль-Ё 123');
  assert.equal(l.statusCode, 200);
  assert.equal(lib.session(reqWith(l)), id);
});

test('регистрация: тот же пароль у двоих даёт разные хэши (соль)', async () => {
  await reg('user_a'); await reg('user_b');
  const pws = accKeys().map((k) => JSON.parse(__raw(k)).pw);
  assert.equal(pws.length, 2);
  assert.notEqual(pws[0], pws[1]);
});

test('регистрация: занятый никнейм (без учёта регистра) → 409, счётчик не растёт, лишних аккаунтов нет', async () => {
  assert.equal((await reg('anna')).statusCode, 200);
  const r = await reg('ANNA');
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /занят/);
  assert.equal(__raw('users'), '1');
  assert.equal(accKeys().length, 1);
  assert.equal(r.headers['set-cookie'], undefined);
});

test('регистрация: недопустимые никнеймы и пароли → 400, в базу ничего не попадает', async () => {
  const bad = ['ab', 'a'.repeat(25), 'вася', 'a b', '_anna', 'an@na', '', null, 42];
  for (const n of bad) assert.equal((await reg(n)).statusCode, 400, String(n));
  for (const p of ['1234567', '', null, 12345678, 'x'.repeat(201)]) assert.equal((await reg('anna', p)).statusCode, 400, String(p));
  assert.deepEqual(__keys().filter((k) => !k.startsWith('rl:')), []);
});

test('регистрация: лимит MAX_USERS, счётчик возвращается', async () => {
  process.env.MAX_USERS = '2';
  assert.equal((await reg('user_a')).statusCode, 200);
  assert.equal((await reg('user_b')).statusCode, 200);
  const r = await reg('user_c');
  assert.equal(r.statusCode, 403);
  assert.match(r.body.error, /лимит/);
  assert.equal(__raw('users'), '2');
  assert.equal(accKeys().length, 2);
});

test('регистрация: не больше 10 попыток в час с одного адреса, другой адрес не затронут', async (t) => {
  const clock = fakeClock(t);
  for (let i = 0; i < 10; i++) assert.equal((await reg('user_' + i)).statusCode, 200, 'попытка ' + i);
  const r = await reg('user_x');
  assert.equal(r.statusCode, 429);
  assert.equal((await reg('user_x', PASS, { ip: '10.0.0.2' })).statusCode, 200);
  clock.advance(61 * 60 * 1000);
  assert.equal((await reg('user_y')).statusCode, 200, 'через час можно снова');
});

/* ---------- вход ---------- */
test('вход: неверный пароль и неизвестный никнейм дают один и тот же ответ', async () => {
  await reg('anna');
  const a = await login('anna', 'wrong-password');
  const b = await login('nobody', PASS);
  assert.equal(a.statusCode, 401);
  assert.equal(b.statusCode, 401);
  assert.deepEqual(a.body, b.body);
  assert.equal(a.headers['set-cookie'], undefined);
  assert.equal((await login('anna', null)).statusCode, 401);
  assert.equal((await login('anna', 'x'.repeat(5000))).statusCode, 401);
});

test('вход: 10 неудач блокируют вход даже с верным паролем; чужой никнейм с другого адреса не затронут; через 15 минут снова можно', async (t) => {
  await reg('anna'); await reg('boris');
  const clock = fakeClock(t);
  await Promise.all(Array.from({ length: 10 }, () => login('anna', 'wrong-password')));
  const r = await login('anna', PASS);
  assert.equal(r.statusCode, 429);
  assert.match(r.body.error, /Подождите 15 мин/);
  assert.equal((await login('boris', PASS)).statusCode, 429, 'тот же адрес заблокирован целиком');
  assert.equal((await login('boris', PASS, { ip: '10.0.0.9' })).statusCode, 200, 'другой адрес и другой никнейм в порядке');
  assert.equal((await login('anna', PASS, { ip: '10.0.0.9' })).statusCode, 429, 'сам никнейм заблокирован и с другого адреса');
  clock.advance(15 * 60 * 1000 + 1000);
  assert.equal((await login('anna', PASS)).statusCode, 200);
});

test('вход: 10 неудач на один никнейм с разных адресов блокируют его, другие никнеймы нет', async () => {
  await reg('anna'); await reg('boris');
  await Promise.all(Array.from({ length: 10 }, (_, i) => login('anna', 'wrong-password', { ip: '20.0.0.' + i })));
  assert.equal((await login('anna', PASS, { ip: '20.0.1.1' })).statusCode, 429);
  assert.equal((await login('boris', PASS, { ip: '20.0.1.1' })).statusCode, 200);
});

test('вход: успешный вход счётчик неудач не сбрасывает', async () => {
  await reg('anna');
  await Promise.all(Array.from({ length: 9 }, () => login('anna', 'wrong-password')));
  assert.equal((await login('anna', PASS)).statusCode, 200);
  await login('anna', 'wrong-password');
  assert.equal((await login('anna', PASS)).statusCode, 429);
});

/* ---------- выход и прочее ---------- */
test('выход: чистит cookie и не требует сессии', async () => {
  const r = await post({ action: 'logout' });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['set-cookie'], /cb_session=;.*Max-Age=0/);
});

test('метод и тело: GET → 405; неизвестное действие и не-JSON → 400; JSON-строка принимается', async () => {
  const g = mockRes();
  await auth(mockReq({ method: 'GET' }), g);
  assert.equal(g.statusCode, 405);
  assert.equal((await post({ action: 'drop' })).statusCode, 400);
  assert.equal((await post({})).statusCode, 400);
  assert.equal((await post('не json')).statusCode, 400);
  assert.equal((await post(null)).statusCode, 400);
  assert.equal((await post(JSON.stringify({ action: 'register', user: 'anna', pass: PASS }))).statusCode, 200);
});

test('сбои окружения: нет SESSION_SECRET или короткий, нет Redis → 500 без утечки; Redis лежит → 503', async () => {
  const saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'short';
  assert.equal((await reg('anna')).statusCode, 500);
  assert.equal((await login('anna')).statusCode, 500);
  process.env.SESSION_SECRET = saved;
  const url = process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_URL;
  assert.equal((await reg('anna')).statusCode, 500);
  process.env.KV_REST_API_URL = url;
  __fail('network');
  const r = await reg('anna');
  assert.equal(r.statusCode, 503);
  assert.ok(!JSON.stringify(r.body).includes('redis.test'));
  assert.equal((await login('anna')).statusCode, 503);
});

test('регистрация: две одновременные заявки на один никнейм: проходит одна, счётчик и аккаунты без хвостов', async () => {
  const rs = await Promise.all([reg('anna', PASS, { ip: '10.0.0.1' }), reg('anna', PASS, { ip: '10.0.0.2' })]);
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(__raw('users'), '1');
  assert.equal(accKeys().length, 1);
  assert.equal(__keys().filter((k) => k.startsWith('nick:')).length, 1);
});

test('DB_PREFIX применяется ко всем ключам: аккаунты, ники, счётчики, лимиты', async () => {
  process.env.DB_PREFIX = 't';
  await reg('anna');
  await login('anna', 'wrong-password');
  assert.ok(__keys().length >= 5, __keys().join(', '));
  assert.ok(__keys().every((k) => k.startsWith('t:')), __keys().join(', '));
});
