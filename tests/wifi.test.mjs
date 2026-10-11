// Эндпоинт api/wifi.js: сети пользователя (список до 5) в Redis (ключ wifi:<id>), проверка данных, QR, изоляция.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __fail, __raw } from './redis.mjs';
import { mockReq, mockRes, setEnv, sessionCookie } from './helpers.mjs';

setEnv();
const lib = await import('../api/_lib.js');
const acc = await import('../api/_acc.js');
const wifiMod = await import('../api/wifi.js');
const wifi = wifiMod.default;

beforeEach(() => { __reset(); setEnv(); });

const signup = (name) => sessionCookie(acc, lib, name);
async function call(method, cookie, body, ct = 'application/json', query) {
  const res = mockRes();
  const headers = { ...(cookie ? { cookie } : {}), ...(method === 'PUT' && ct ? { 'content-type': ct } : {}) };
  await wifi(mockReq({ method, headers, body, query }), res);
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
  assert.deepEqual(r.body, { configured: false, nets: [] });
  assert.equal(r.headers['cache-control'], 'no-store');
  delete process.env.WIFI_SSID; delete process.env.WIFI_PASSWORD;
});

test('PUT → GET: сеть сохранена, в ответе список с QR 0/1 и данными для показа, полей первой сети наверху нет', async () => {
  const c = await signup('anna');
  const put = await call('PUT', c, NET);
  assert.equal(put.statusCode, 200);
  assert.equal(put.body.configured, true);
  assert.deepEqual(Object.keys(put.body).sort(), ['configured', 'nets']);
  assert.equal(put.body.nets.length, 1);
  assert.match(put.body.nets[0].id, /^[a-z0-9]{2,12}$/);
  assert.equal(put.body.nets[0].ssid, 'HomeNet');
  assert.equal(put.body.nets[0].password, 'secret-pass-1');
  const q = put.body.nets[0].qr;
  assert.ok(q.size >= 21 && q.rows.length === q.size && /^[01]+$/.test(q.rows[0]));
  const got = await call('GET', c);
  assert.deepEqual(got.body, put.body);
});

test('пользователи изолированы: пароль одного не виден другому', async () => {
  const a = await signup('anna'), b = await signup('boris');
  await call('PUT', a, NET);
  assert.deepEqual((await call('GET', b)).body, { configured: false, nets: [] });
  await call('PUT', b, { ...NET, ssid: 'BorisNet', password: 'boris-pass-12' });
  assert.equal((await call('GET', a)).body.nets[0].ssid, 'HomeNet');
});

test('замена и удаление: PUT перезаписывает, DELETE снимает настройку и запись', async () => {
  const c = await signup('anna');
  await call('PUT', c, NET);
  await call('PUT', c, { ...NET, ssid: 'Other', hidden: true });
  const got = (await call('GET', c)).body;
  assert.equal(got.nets[0].ssid, 'Other');
  assert.equal(got.nets[0].hidden, true);
  const del = await call('DELETE', c);
  assert.deepEqual(del.body, { configured: false, nets: [] });
  assert.deepEqual((await call('GET', c)).body, { configured: false, nets: [] });
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
  assert.equal(r.body.nets[0].password, '');
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

/* ---------- список сетей (до 5) ---------- */
const net = (n, extra = {}) => ({ ssid: 'Net' + n, password: 'secret-pass-' + n, security: 'WPA', hidden: false, ...extra });

test('список: add добавляет сети по порядку, шестая — 400 limit', async () => {
  const c = await signup('anna');
  for (let i = 1; i <= 5; i++) {
    const r = await call('PUT', c, net(i, { add: true }));
    assert.equal(r.statusCode, 200, 'сеть ' + i);
    assert.equal(r.body.nets.length, i);
    assert.equal(r.body.nets[0].ssid, 'Net1', 'первая сеть остаётся первой');
  }
  const six = await call('PUT', c, net(6, { add: true }));
  assert.equal(six.statusCode, 400);
  assert.deepEqual(six.body, { error: 'limit' });
  const got = (await call('GET', c)).body;
  assert.deepEqual(got.nets.map((n) => n.ssid), ['Net1', 'Net2', 'Net3', 'Net4', 'Net5']);
  assert.equal(new Set(got.nets.map((n) => n.id)).size, 5, 'id разные');
  assert.ok(got.nets.every((n) => n.qr && n.qr.size >= 21));
});

test('список: PUT с id правит эту сеть и не трогает остальные; чужой id — 404 nonet; id не строка или id вместе с add — 400 bad', async () => {
  const c = await signup('anna');
  await call('PUT', c, net(1, { add: true })); await call('PUT', c, net(2, { add: true }));
  const [a, b] = (await call('GET', c)).body.nets;
  const r = await call('PUT', c, net(9, { id: b.id, hidden: true }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.nets.map((n) => [n.id, n.ssid, n.hidden]), [[a.id, 'Net1', false], [b.id, 'Net9', true]]);
  const no = await call('PUT', c, net(3, { id: 'zzzz' }));
  assert.equal(no.statusCode, 404);
  assert.deepEqual(no.body, { error: 'nonet' });
  assert.equal((await call('PUT', c, net(3, { id: 5 }))).statusCode, 400);
  assert.deepEqual((await call('PUT', c, net(3, { id: a.id, add: true }))).body, { error: 'bad' });
  assert.equal((await call('GET', c)).body.nets.length, 2, 'ошибки ничего не записали');
  const bad = await call('PUT', c, { ...net(3, { id: a.id }), password: 'short' });
  assert.deepEqual(bad.body, { error: 'password' }, 'проверка данных раньше проверки id');
});

test('список: PUT без id и без add (прежний вид) заменяет первую сеть или создаёт, DELETE без id снимает первую', async () => {
  const c = await signup('anna');
  await call('PUT', c, net(1)); // сетей нет: создаётся
  await call('PUT', c, net(2, { add: true }));
  const r = await call('PUT', c, net(7));
  assert.deepEqual(r.body.nets.map((n) => n.ssid), ['Net7', 'Net2']);
  const d = await call('DELETE', c);
  assert.deepEqual(d.body.nets.map((n) => n.ssid), ['Net2']);
});

test('список: DELETE ?id= удаляет эту сеть, неизвестный id ничего не меняет, последняя сеть удаляет и запись', async () => {
  const c = await signup('anna');
  await call('PUT', c, net(1, { add: true })); await call('PUT', c, net(2, { add: true }));
  const [a, b] = (await call('GET', c)).body.nets;
  const unknown = await call('DELETE', c, undefined, 'application/json', { id: 'nope' });
  assert.equal(unknown.statusCode, 200);
  assert.equal(unknown.body.nets.length, 2);
  const one = await call('DELETE', c, undefined, 'application/json', { id: a.id });
  assert.deepEqual(one.body.nets.map((n) => n.id), [b.id]);
  const last = await call('DELETE', c, undefined, 'application/json', { id: b.id });
  assert.deepEqual(last.body, { configured: false, nets: [] });
  assert.equal(__raw('wifi:' + idOf(c)), undefined, 'запись удалена');
});

test('старая запись одной сети читается как список из одной (id w1) и переписывается при правке', async () => {
  const c = await signup('anna'), id = idOf(c);
  await lib.writeRec('wifi', id, { ssid: 'Old', password: 'old-pass-123', security: 'WPA', hidden: true }, null);
  const got = (await call('GET', c)).body;
  assert.equal(got.configured, true);
  assert.deepEqual(got.nets.map((n) => [n.id, n.ssid, n.hidden]), [['w1', 'Old', true]]);
  assert.ok(!('nets' in JSON.parse(__raw('wifi:' + id).d)), 'GET запись не переписывает');
  const add = await call('PUT', c, net(2, { add: true }));
  assert.deepEqual(add.body.nets.map((n) => n.ssid), ['Old', 'Net2']);
  assert.deepEqual(JSON.parse(__raw('wifi:' + id).d).nets.map((n) => n.id).slice(0, 1), ['w1']);
});

test('битые и лишние сети в записи пропускаются, повторный id заменяется', async () => {
  const c = await signup('anna'), id = idOf(c);
  const rows = [net(1, { id: 'dup' }), net(2, { id: 'dup' }), { ssid: '', security: 'WPA', password: 'x', id: 'bad' }, net(3, { id: 5 }), net(4), net(5), net(6), net(7)];
  await lib.writeRec('wifi', id, { nets: rows }, null);
  const got = (await call('GET', c)).body.nets;
  assert.equal(got.length, 5, 'не больше пяти');
  assert.deepEqual(got.map((n) => n.ssid), ['Net1', 'Net2', 'Net3', 'Net4', 'Net5']);
  assert.equal(new Set(got.map((n) => n.id)).size, 5);
  assert.equal(got[0].id, 'dup');
});

test('список: параллельные добавления не теряют друг друга (CAS)', async () => {
  const c = await signup('anna');
  await Promise.all([1, 2, 3].map((i) => call('PUT', c, net(i, { add: true }))));
  const ssids = (await call('GET', c)).body.nets.map((n) => n.ssid).sort();
  assert.deepEqual(ssids, ['Net1', 'Net2', 'Net3']);
});
