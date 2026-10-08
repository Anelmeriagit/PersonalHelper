// Сессия и действия api/auth.js (вход только через Google; сам вход — tests/google.test.mjs) на заглушке Redis.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __keys, __raw, __fail } from './redis.mjs';
import { mockReq, mockRes, setEnv, fakeClock } from './helpers.mjs';

setEnv();
const lib = await import('../api/_lib.js');
const auth = (await import('../api/auth.js')).default;

beforeEach(() => { __reset(); setEnv(); });

const DAY = 864e5, PASS = 'correct-horse';
async function post(body, { ip = '10.0.0.1' } = {}) {
  const res = mockRes();
  await auth(mockReq({ method: 'POST', headers: { 'x-real-ip': ip }, body }), res);
  return res;
}

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

/* ---------- пароля и регистрации больше нет ---------- */
test('регистрация и вход по паролю убраны: действия register и login → 400, в базу ничего не пишется, cookie нет', async () => {
  for (const action of ['register', 'login']) {
    for (const o of [{}, { user: 'anna', pass: PASS }]) {
      const r = await post({ action, ...o });
      assert.equal(r.statusCode, 400, action);
      assert.deepEqual(r.body, { error: 'bad request' });
      assert.equal(r.headers['set-cookie'], undefined, 'cookie не выдаётся');
    }
  }
  process.env.REG_OPEN = '1'; // старая переменная ничего не открывает
  assert.equal((await post({ action: 'register', user: 'anna', pass: PASS })).statusCode, 400);
  assert.deepEqual(__keys(), [], 'Redis не тронут');
});

test('устаревший аккаунт с никнеймом и паролем по паролю не входит; его живая сессия работает как раньше', async () => {
  const id = 'a1'.repeat(16);
  const { cmd } = await import('../api/_db.js');
  await cmd('SET', 'acc:' + id, JSON.stringify({ nick: 'anna', pw: 'ab:cd', at: 1 }));
  await cmd('SET', 'nick:anna', id);
  const r = await post({ action: 'login', user: 'anna', pass: PASS });
  assert.equal(r.statusCode, 400);
  assert.equal(r.headers['set-cookie'], undefined);
  const me = await post({ action: 'me' });
  assert.equal(me.statusCode, 401, 'без сессии нельзя');
  const res = mockRes();
  await auth(mockReq({ method: 'POST', headers: { cookie: lib.makeCookie(id).split(';')[0] }, body: { action: 'me' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { id, name: '', email: '', tg: { linked: false }, partner: { linked: false } });
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
  assert.equal((await post(JSON.stringify({ action: 'logout' }))).statusCode, 200);
});

test('сбои окружения: нет SESSION_SECRET или короткий, нет Redis → 500 без утечки; Redis лежит → 503', async () => {
  const me = () => post({ action: 'me' });
  const saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'short';
  assert.equal((await me()).statusCode, 500);
  process.env.SESSION_SECRET = saved;
  const url = process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_URL;
  assert.equal((await me()).statusCode, 500);
  process.env.KV_REST_API_URL = url;
  const id = 'b2'.repeat(16);
  __fail('network');
  const res = mockRes();
  await auth(mockReq({ method: 'POST', headers: { cookie: lib.makeCookie(id).split(';')[0] }, body: { action: 'me' } }), res);
  assert.equal(res.statusCode, 503);
  assert.ok(!JSON.stringify(res.body).includes('redis.test'));
});

test('DB_PREFIX применяется ко всем ключам аккаунта: запись, указатель Google, счётчик, лимит', async () => {
  process.env.DB_PREFIX = 't';
  const { googleAccount } = await import('../api/_acc.js');
  await googleAccount('sub-prefix', 'a@b.co', 100);
  assert.ok(__keys().length >= 3, __keys().join(', '));
  assert.ok(__keys().every((k) => k.startsWith('t:')), __keys().join(', '));
});
