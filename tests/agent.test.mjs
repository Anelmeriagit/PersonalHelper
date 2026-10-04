// Эндпоинт api/agent.js: личный список строк в Redis (ключ agent:<id>), доступ по сессии, изоляция пользователей.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __fail, __raw } from './redis.mjs';
import { mockReq, mockRes, setEnv } from './helpers.mjs';

setEnv();
const lib = await import('../api/_lib.js');
const auth = (await import('../api/auth.js')).default;
const agentMod = await import('../api/agent.js');
const agent = agentMod.default;

beforeEach(() => { __reset(); setEnv(); process.env.REG_OPEN = '1'; });

async function signup(nick) {
  const res = mockRes();
  await auth(mockReq({ method: 'POST', headers: { 'x-real-ip': '1.1.1.1' }, body: { action: 'register', user: nick, pass: 'correct-horse' } }), res);
  assert.equal(res.statusCode, 200);
  return String(res.headers['set-cookie']).split(';')[0];
}
async function call(method, cookie, body) {
  const res = mockRes();
  await agent(mockReq({ method, headers: cookie ? { cookie } : {}, body }), res);
  return res;
}
const idOf = (c) => lib.session({ headers: { cookie: c } });

test('без сессии 401, неподдерживаемый метод 405', async () => {
  assert.equal((await call('GET')).statusCode, 401);
  assert.equal((await call('PUT', null, { rows: [] })).statusCode, 401);
  const c = await signup('anna');
  assert.equal((await call('DELETE', c)).statusCode, 405);
});

test('GET нового аккаунта: четыре строки по умолчанию без времени', async () => {
  const c = await signup('anna');
  const r = await call('GET', c);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(r.body.rows.map((x) => x.app), ['app', 'opera', 'mozilla', 'edge']);
  assert.ok(r.body.rows.every((x) => x.h === null && x.m === null && x.at === null));
});

test('PUT → GET: список сохранён в порядке массива, у строки с временем есть at', async () => {
  const c = await signup('anna');
  const put = await call('PUT', c, { rows: [{ app: 'Opera', h: 9, m: 30 }, { app: 'Мой клиент', h: null, m: null }] });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.body.rows.map((x) => x.app), ['opera', 'Мой клиент'], 'встроенный id в любом регистре, своё название как есть');
  assert.ok(Number.isSafeInteger(put.body.rows[0].at) && put.body.rows[0].at > Date.now());
  assert.equal(put.body.rows[1].at, null);
  const got = await call('GET', c);
  assert.deepEqual(got.body.rows, put.body.rows);
});

test('at от клиента игнорируется; без смены ч:мин сервер его не двигает', async () => {
  const c = await signup('anna');
  const a = (await call('PUT', c, { rows: [{ app: 'app', h: 3, m: 10, at: 5 }] })).body.rows[0];
  assert.notEqual(a.at, 5);
  const b = (await call('PUT', c, { rows: [{ id: a.id, app: 'edge', h: 3, m: 10 }] })).body.rows[0];
  assert.equal(b.at, a.at, 'смена названия не переносит сброс');
  const d = (await call('PUT', c, { rows: [{ id: a.id, app: 'edge', h: 4, m: 10 }] })).body.rows[0];
  assert.notEqual(d.at, a.at, 'смена времени пересчитывает');
});

test('пользователи изолированы: у каждого свой список', async () => {
  const a = await signup('anna'), b = await signup('boris');
  await call('PUT', a, { rows: [{ app: 'Секрет Анны', h: 1, m: 0 }] });
  const rb = await call('GET', b);
  assert.deepEqual(rb.body.rows.map((x) => x.app), ['app', 'opera', 'mozilla', 'edge']);
  await call('PUT', b, { rows: [{ app: 'edge', h: null, m: null }] });
  assert.deepEqual((await call('GET', a)).body.rows.map((x) => x.app), ['Секрет Анны']);
});

test('проверки: лимит 12 строк, не-массив, недопустимые названия отбрасываются', async () => {
  const c = await signup('anna');
  const many = Array.from({ length: 13 }, () => ({ app: 'app', h: null, m: null }));
  const lim = await call('PUT', c, { rows: many });
  assert.equal(lim.statusCode, 400);
  assert.deepEqual(lim.body, { error: 'limit' });
  assert.equal((await call('PUT', c, { rows: 'x' })).statusCode, 400);
  assert.equal((await call('PUT', c, {})).statusCode, 400);
  const r = await call('PUT', c, { rows: [{ app: '<b>x</b>' }, { app: 'a'.repeat(41) }, { app: 'ok', h: 24, m: 15 }] });
  assert.deepEqual(r.body.rows.map((x) => [x.app, x.h, x.m]), [['ok', null, null]], 'часы 0–23, минуты 0–50 с шагом 10');
});

test('запись в Redis: ключ agent:<id>, Blob не используется', async () => {
  const c = await signup('anna');
  await call('PUT', c, { rows: [{ app: 'app', h: null, m: null }] });
  const raw = __raw('agent:' + idOf(c));
  assert.equal(raw.v, '1');
  assert.ok(JSON.parse(raw.d).rows.length === 1);
});

test('DB_PREFIX применяется и к агенту', async () => {
  process.env.DB_PREFIX = 't:';
  const c = await signup('anna');
  await call('PUT', c, { rows: [{ app: 'app', h: null, m: null }] });
  assert.equal(__raw('t:agent:' + idOf(c)).v, '1');
  assert.equal(__raw('agent:' + idOf(c)), undefined);
});

test('одновременные PUT: оба проходят (повтор после перечитывания), победила последняя запись', async () => {
  const c = await signup('anna');
  const rs = await Promise.all([
    call('PUT', c, { rows: [{ app: 'app', h: null, m: null }] }),
    call('PUT', c, { rows: [{ app: 'edge', h: null, m: null }] }),
  ]);
  assert.deepEqual(rs.map((r) => r.statusCode), [200, 200]);
  const got = await call('GET', c);
  assert.equal(got.body.rows.length, 1);
  assert.equal(__raw('agent:' + idOf(c)).v, '2');
});

test('Redis недоступен: 500 server без падения', async () => {
  const c = await signup('anna');
  __fail('network');
  assert.deepEqual((await call('GET', c)).body, { error: 'server' });
  assert.equal((await call('PUT', c, { rows: [] })).statusCode, 500);
});

test('nextAt: ближайшее московское время; наступившее — завтра', () => {
  const now = Date.UTC(2026, 9, 4, 9, 0); // 12:00 по Москве
  assert.equal(agentMod.nextAt(13, 0, now), Date.UTC(2026, 9, 4, 10, 0));
  assert.equal(agentMod.nextAt(12, 0, now), Date.UTC(2026, 9, 5, 9, 0));
  assert.equal(agentMod.nextAt(2, 30, now), Date.UTC(2026, 9, 4, 23, 30));
});
