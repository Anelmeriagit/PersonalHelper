// Общий список Wi-Fi соединённых аккаунтов (часть 4): запись wfs:<меньший id>:<больший id> в api/wifi.js, выбор при соединении (pair-join, pair-wifi),
// копии при разрыве (unpair в api/_acc.js), вид ключа в api/_backup.js.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __keys, __cmdLog } from './redis.mjs';
import { mockReq, mockRes, setEnv } from './helpers.mjs';

setEnv();
const auth = (await import('../api/auth.js')).default;
const wifi = (await import('../api/wifi.js')).default;
const acc = await import('../api/_acc.js');
const lib = await import('../api/_lib.js');
const backup = await import('../api/_backup.js');

beforeEach(() => { __reset(); setEnv(); });

async function post(u, body) {
  const res = mockRes();
  await auth(mockReq({ method: 'POST', headers: { cookie: u.cookie, 'x-real-ip': '10.0.0.9' }, body }), res);
  return res;
}
async function w(u, method, body, query) {
  const res = mockRes();
  await wifi(mockReq({ method, headers: { cookie: u.cookie, ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}) }, body, query }), res);
  return res;
}
async function signUp(name) {
  const { id } = await acc.googleAccount('sub-' + name, '', 100);
  return { id, cookie: lib.makeCookie(id).split(';')[0] };
}
const N = (n, o) => ({ ssid: 'Net' + n, password: 'secret-pass-' + n, security: 'WPA', hidden: false, ...(o || {}) });
const put = (u, n, o) => w(u, 'PUT', N(n, o));
const add = (u, n) => w(u, 'PUT', N(n, { add: true }));
const names = (r) => r.body.nets.map((x) => x.ssid);
const link = async (u) => (await post(u, { action: 'pair-link' })).body.token;
// a даёт ссылку, b её открывает
const join = async (a, b) => post(b, { action: 'pair-join', token: await link(a) });
const SK = (a, b) => 'wfs:' + acc.pairId(a.id, b.id);

test('обе стороны без сетей: общая запись создаётся пустой, сеть одного видна другому, выбора нет', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  const r = await join(a, b);
  assert.deepEqual(r.body.wifi, { choose: false });
  assert.ok(__keys().includes(SK(a, b)));
  assert.equal((await put(b, 1)).statusCode, 200);
  assert.deepEqual(names(await w(a, 'GET')), ['Net1']);
  assert.ok(!__keys().includes('wifi:' + a.id) && !__keys().includes('wifi:' + b.id), 'личные записи не создаются');
  assert.equal((await w(a, 'DELETE', undefined, { id: (await w(a, 'GET')).body.nets[0].id })).statusCode, 200);
  assert.deepEqual((await w(b, 'GET')).body, { configured: false, nets: [] });
  assert.ok(__keys().includes(SK(a, b)), 'пустая общая запись остаётся, пока связь есть');
  assert.deepEqual(names(await add(a, 2)), ['Net2'], 'и принимает новые сети');
});

test('сети только у одного: появляются у второго; правка и удаление любым из двоих', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  await put(a, 1); await add(a, 2);
  const r = await join(a, b);
  assert.deepEqual(r.body.wifi, { choose: false });
  const got = await w(b, 'GET');
  assert.deepEqual(names(got), ['Net1', 'Net2']);
  assert.equal(got.body.nets[0].password, 'secret-pass-1');
  const id1 = got.body.nets[0].id;
  assert.equal((await w(b, 'PUT', N(9, { id: id1 }))).statusCode, 200);
  assert.deepEqual(names(await w(a, 'GET')), ['Net9', 'Net2'], 'правка второго видна первому');
  assert.deepEqual(names(await w(b, 'DELETE', undefined, { id: id1 })), ['Net2']);
  assert.deepEqual(names(await w(a, 'GET')), ['Net2']);
  assert.equal((await w(b, 'PUT', N(7, { id: 'nope' }))).body.error, 'nonet');
});

test('у одного сети есть, у второго подмножество: без выбора, список — объединение', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  await put(a, 1); await add(a, 2); await put(b, 2);
  const r = await join(a, b);
  assert.deepEqual(r.body.wifi, { choose: false });
  assert.deepEqual(names(await w(b, 'GET')).sort(), ['Net1', 'Net2']);
});

test('одинаковые id у двоих (старая запись одной сети даёт w1 обоим): после «обе» id разные', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  const { putDoc, key } = await import('../api/_db.js');
  await putDoc(key('wifi', a.id), { ssid: 'Old1', password: 'secret-pass-1', security: 'WPA', hidden: false }, 0);
  await putDoc(key('wifi', b.id), { ssid: 'Old2', password: 'secret-pass-2', security: 'WPA', hidden: false }, 0);
  assert.equal((await w(a, 'GET')).body.nets[0].id, 'w1');
  assert.equal((await w(b, 'GET')).body.nets[0].id, 'w1');
  assert.equal((await join(a, b)).body.wifi.choose, true);
  assert.equal((await post(b, { action: 'pair-wifi', choice: 'both' })).statusCode, 200);
  const got = await w(a, 'GET');
  assert.deepEqual(names(got), ['Old2', 'Old1']);
  assert.equal(new Set(got.body.nets.map((x) => x.id)).size, 2);
});

test('у каждого своя сеть: pair-join сообщает о выборе без паролей, личные списки пока работают как раньше', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  await put(a, 1); await put(b, 2);
  const r = await join(a, b);
  assert.deepEqual(r.body.wifi, {
    choose: true,
    mine: [{ ssid: 'Net2', security: 'WPA', hidden: false }],
    partner: [{ ssid: 'Net1', security: 'WPA', hidden: false }],
    both: 2,
  });
  assert.ok(!JSON.stringify(r.body).includes('secret-pass'));
  assert.deepEqual(names(await w(a, 'GET')), ['Net1']);
  assert.deepEqual(names(await w(b, 'GET')), ['Net2']);
  await add(a, 3); // правка до выбора идёт в личный список
  assert.deepEqual(names(await w(a, 'GET')), ['Net1', 'Net3']);
  const st = await post(a, { action: 'pair-wifi' }); // у давшего ссылку то же состояние со своей стороны
  assert.deepEqual([st.statusCode, st.body.pending, st.body.both], [200, true, 3]);
  assert.deepEqual(st.body.mine.map((x) => x.ssid), ['Net1', 'Net3']);
  assert.deepEqual(st.body.partner.map((x) => x.ssid), ['Net2']);
});

test('выбор «мою», «партнёра», «обе»: общий список у обоих, повтор ничего не меняет', async () => {
  for (const [choice, want] of [['mine', ['Net2']], ['partner', ['Net1', 'Net3']], ['both', ['Net2', 'Net1', 'Net3']]]) {
    __reset(); setEnv();
    const a = await signUp('anna'), b = await signUp('boris');
    await put(a, 1); await add(a, 3); await put(b, 2);
    await join(a, b);
    const r = await post(b, { action: 'pair-wifi', choice });
    assert.deepEqual([r.statusCode, r.body], [200, { pending: false }], choice);
    assert.deepEqual(names(await w(a, 'GET')), want, choice);
    assert.deepEqual(names(await w(b, 'GET')), want, choice);
    assert.deepEqual((await post(a, { action: 'pair-wifi', choice: 'mine' })).body, { pending: false }, 'повтор: выбор уже сделан');
    assert.deepEqual(names(await w(a, 'GET')), want);
  }
});

test('«обе» при больше чем 5 сетях вместе: 400 limit, выбор остаётся; остальные варианты работают', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  await put(a, 1); await add(a, 2); await add(a, 3);
  await put(b, 4); await add(b, 5); await add(b, 6);
  const r = await join(a, b);
  assert.equal(r.body.wifi.both, 6);
  const bad = await post(b, { action: 'pair-wifi', choice: 'both' });
  assert.deepEqual([bad.statusCode, bad.body.code], [400, 'limit']);
  assert.equal((await post(b, { action: 'pair-wifi' })).body.pending, true);
  assert.equal((await post(b, { action: 'pair-wifi', choice: 'partner' })).body.pending, false);
  assert.equal((await w(a, 'GET')).body.nets.length, 3);
});

test('pair-wifi: без связи 409 nopair, неверный выбор 400, без сессии 401; в общем списке до 5 сетей', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  let r = await post(a, { action: 'pair-wifi' });
  assert.deepEqual([r.statusCode, r.body.code], [409, 'nopair']);
  const res = mockRes();
  await auth(mockReq({ method: 'POST', headers: { 'x-real-ip': '10.0.0.9' }, body: { action: 'pair-wifi' } }), res);
  assert.equal(res.statusCode, 401);
  await join(a, b);
  r = await post(b, { action: 'pair-wifi', choice: 'zzz' });
  assert.deepEqual([r.statusCode, r.body.code], [400, 'bad']);
  assert.deepEqual((await post(b, { action: 'pair-wifi' })).body, { pending: false }, 'нечего выбирать');
  for (let i = 1; i <= 5; i++) assert.equal((await add(i % 2 ? a : b, i)).statusCode, 200);
  assert.equal((await add(a, 6)).body.error, 'limit');
});

test('пара до этой правки (связь есть, общей записи нет): запись создаётся при первом обращении к Wi-Fi', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  await put(a, 1); await put(b, 2); // у каждого свои сети: у пары выбор
  await post(b, { action: 'pair-join', token: await link(a) });
  const { del } = await import('../api/_db.js');
  await del(SK(a, b)); // как у пары, соединённой до этой правки
  assert.ok(!__keys().includes(SK(a, b)));
  assert.deepEqual(names(await w(a, 'GET')), ['Net1'], 'первое обращение создало запись; выбор ещё не сделан, личный список');
  assert.ok(__keys().includes(SK(a, b)));
  assert.equal((await post(a, { action: 'pair-wifi' })).body.pending, true);
});

test('разрыв: общий список остаётся копией у обоих, общая запись удалена', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  await put(a, 1); await join(a, b); await add(b, 2);
  await post(a, { action: 'pair-drop' });
  assert.ok(!__keys().includes(SK(a, b)));
  assert.deepEqual(names(await w(a, 'GET')), ['Net1', 'Net2']);
  assert.deepEqual(names(await w(b, 'GET')), ['Net1', 'Net2']);
  await put(a, 8); // дальше личные списки независимы
  assert.deepEqual(names(await w(b, 'GET')), ['Net1', 'Net2']);
});

test('разрыв: пустой общий список убирает личные записи; невыбранный выбор их не трогает', async () => {
  let a = await signUp('anna'), b = await signUp('boris');
  await put(a, 1); await join(a, b);
  await w(b, 'DELETE', undefined, { id: (await w(b, 'GET')).body.nets[0].id });
  await post(b, { action: 'pair-drop' });
  assert.ok(!__keys().includes('wifi:' + a.id) && !__keys().includes('wifi:' + b.id));
  __reset(); setEnv();
  a = await signUp('anna'); b = await signUp('boris');
  await put(a, 1); await put(b, 2); await join(a, b);
  await post(a, { action: 'pair-drop' });
  assert.deepEqual(names(await w(a, 'GET')), ['Net1']);
  assert.deepEqual(names(await w(b, 'GET')), ['Net2']);
});

test('удаление аккаунта: у партнёра остаётся копия общего списка', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  await put(a, 1); await join(a, b); await add(b, 2);
  await acc.deleteAccount(a.id);
  assert.ok(!__keys().some((k) => k.startsWith('wfs:')));
  assert.deepEqual(names(await w(b, 'GET')), ['Net1', 'Net2']);
});

test('новая связь не наследует общую запись, оставшуюся от прежней связи', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  const { putDoc } = await import('../api/_db.js');
  await putDoc(SK(a, b), { nets: [N(1)] }, 0); // запись, которую разрыв не дочистил (в тестах префикса ключей нет)
  assert.ok(__keys().includes(SK(a, b)));
  await join(a, b);
  assert.deepEqual((await w(a, 'GET')).body, { configured: false, nets: [] });
  assert.deepEqual((await w(b, 'GET')).body, { configured: false, nets: [] });
});

test('резервная копия: wfs — известный вид (hash)', () => {
  assert.equal(backup.KNOWN.get('wfs'), 'hash');
});

test('расход команд GET /api/wifi: без связи 2, со связью 4', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  await put(a, 1);
  __cmdLog(true);
  await w(a, 'GET');
  const alone = __cmdLog().length;
  await join(a, b);
  __cmdLog(true);
  await w(a, 'GET');
  const paired = __cmdLog().length;
  assert.equal(alone, 2, 'без связи: ' + alone);
  assert.equal(paired, 4, 'со связью: ' + paired);
});
