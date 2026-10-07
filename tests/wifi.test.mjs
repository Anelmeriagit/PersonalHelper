// Эндпоинт api/wifi.js: личная сеть пользователя в Redis (ключ wifi:<id>), проверка данных, QR, изоляция.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __fail, __raw } from './redis.mjs';
import { mockReq, mockRes, setEnv } from './helpers.mjs';

setEnv();
const lib = await import('../api/_lib.js');
const acc = await import('../api/_acc.js');
const wifiMod = await import('../api/wifi.js');
const wifi = wifiMod.default;

beforeEach(() => { __reset(); setEnv(); });

async function signup(name) {
  const { id } = await acc.googleAccount('sub-' + name, '', 100);
  return lib.makeCookie(id).split(';')[0];
}
async function call(method, cookie, body, ct = 'application/json') {
  const res = mockRes();
  const headers = { ...(cookie ? { cookie } : {}), ...(method === 'PUT' && ct ? { 'content-type': ct } : {}) };
  await wifi(mockReq({ method, headers, body }), res);
  return res;
}
const idOf = (c) => lib.session({ headers: { cookie: c } });
const NET = { ssid: 'HomeNet', password: 'secret-pass-1', security: 'WPA', hidden: false };

test('без сессии 401 на любой метод, неподдерживаемый метод 405', async () => {
  for (const m of ['GET', 'PUT', 'DELETE']) assert.equal((await call(m, null, NET)).statusCode, 401);
  const c = await signup('anna');
  assert.equal((await call('POST', c, NET)).statusCode, 405);
});

test('новый аккаунт: сеть не настроена; переменные WIFI_* больше не читаются', async () => {
  process.env.WIFI_SSID = 'EnvNet';
  process.env.WIFI_PASSWORD = 'env-password-1';
  const c = await signup('anna');
  const r = await call('GET', c);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { configured: false });
  assert.equal(r.headers['cache-control'], 'no-store');
  delete process.env.WIFI_SSID; delete process.env.WIFI_PASSWORD;
});

test('PUT → GET: сеть сохранена, в ответе QR 0/1 и данные для показа', async () => {
  const c = await signup('anna');
  const put = await call('PUT', c, NET);
  assert.equal(put.statusCode, 200);
  assert.equal(put.body.configured, true);
  assert.equal(put.body.ssid, 'HomeNet');
  assert.equal(put.body.password, 'secret-pass-1');
  assert.ok(put.body.qr.size >= 21 && put.body.qr.rows.length === put.body.qr.size && /^[01]+$/.test(put.body.qr.rows[0]));
  const got = await call('GET', c);
  assert.deepEqual(got.body, put.body);
});

test('пользователи изолированы: пароль одного не виден другому', async () => {
  const a = await signup('anna'), b = await signup('boris');
  await call('PUT', a, NET);
  assert.deepEqual((await call('GET', b)).body, { configured: false });
  await call('PUT', b, { ...NET, ssid: 'BorisNet', password: 'boris-pass-12' });
  assert.equal((await call('GET', a)).body.ssid, 'HomeNet');
});

test('замена и удаление: PUT перезаписывает, DELETE снимает настройку и запись', async () => {
  const c = await signup('anna');
  await call('PUT', c, NET);
  await call('PUT', c, { ...NET, ssid: 'Other', hidden: true });
  const got = (await call('GET', c)).body;
  assert.equal(got.ssid, 'Other');
  assert.equal(got.hidden, true);
  const del = await call('DELETE', c);
  assert.deepEqual(del.body, { configured: false });
  assert.deepEqual((await call('GET', c)).body, { configured: false });
  assert.equal(__raw('wifi:' + idOf(c)), undefined);
});

test('проверка данных: название, защита, пароль по типу защиты', async () => {
  const c = await signup('anna');
  const bad = async (patch, code) => { const r = await call('PUT', c, { ...NET, ...patch }); assert.equal(r.statusCode, 400, JSON.stringify(patch)); assert.deepEqual(r.body, { error: code }); };
  await bad({ ssid: '' }, 'ssid');
  await bad({ ssid: '   ' }, 'ssid');
  await bad({ ssid: 'a'.repeat(33) }, 'ssid');
  await bad({ ssid: 'я'.repeat(17) }, 'ssid'); // 34 байта
  await bad({ ssid: 'bad\nname' }, 'ssid');
  await bad({ security: 'WPA3' }, 'security');
  await bad({ password: 'short' }, 'password');
  await bad({ password: 'p'.repeat(64) }, 'password'); // 64 символа, но не hex
  await bad({ security: 'WEP', password: '123456' }, 'password');
  assert.equal((await call('PUT', c, { ...NET, password: 'a'.repeat(63) })).statusCode, 200);
  assert.equal((await call('PUT', c, { ...NET, password: 'ab12'.repeat(16) })).statusCode, 200, '64 hex-символа');
  assert.equal((await call('PUT', c, { ...NET, security: 'WEP', password: '12345' })).statusCode, 200);
  assert.equal((await call('PUT', c, { ...NET, ssid: 'я'.repeat(16) })).statusCode, 200, '32 байта');
  assert.equal((await call('PUT', c, 'не объект')).statusCode, 400);
});

test('сеть без пароля: пароль не хранится, даже если прислан', async () => {
  const c = await signup('anna');
  const r = await call('PUT', c, { ssid: 'Guest', security: 'nopass', password: 'лишнее', hidden: false });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.password, '');
  assert.ok(!__raw('wifi:' + idOf(c)).d.includes('лишнее'));
});

test('тип содержимого PUT: не JSON → 415', async () => {
  const c = await signup('anna');
  assert.equal((await call('PUT', c, NET, 'text/plain')).statusCode, 415);
});

test('запись в Redis: ключ wifi:<id>; с DB_PREFIX — с префиксом', async () => {
  process.env.DB_PREFIX = 't:';
  const c = await signup('anna');
  await call('PUT', c, NET);
  assert.equal(__raw('t:wifi:' + idOf(c)).v, '1');
  assert.equal(__raw('wifi:' + idOf(c)), undefined);
});

test('Redis недоступен: 500 server, пароль в журнал ошибок не попадает', async () => {
  const c = await signup('anna');
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try {
    __fail('network');
    const r = await call('PUT', c, NET);
    assert.equal(r.statusCode, 500);
    assert.deepEqual(r.body, { error: 'server' });
  } finally { console.error = orig; }
  assert.ok(logged.length > 0 && logged.every((l) => !l.includes('secret-pass-1') && !l.includes('HomeNet')));
});

test('wifiString: экранирование спецсимволов, скрытая и открытая сеть', () => {
  assert.equal(wifiMod.wifiString({ ssid: 'a;b', password: 'p:q,"r\\', security: 'WPA', hidden: false }), 'WIFI:T:WPA;S:a\\;b;P:p\\:q\\,\\"r\\\\;H:false;;');
  assert.equal(wifiMod.wifiString({ ssid: 'Guest', password: '', security: 'nopass', hidden: true }), 'WIFI:T:nopass;S:Guest;H:true;;');
});
