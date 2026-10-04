// Эндпоинт api/data.js: доступ по сессии, документы разных пользователей, версии частей, конфликты.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __fail, __raw } from './redis.mjs';
import { mockReq, mockRes, setEnv } from './helpers.mjs';

setEnv();
const lib = await import('../api/_lib.js');
const auth = (await import('../api/auth.js')).default;
const data = (await import('../api/data.js')).default;

beforeEach(() => { __reset(); setEnv(); process.env.REG_OPEN = '1'; });

async function signup(nick) {
  const res = mockRes();
  await auth(mockReq({ method: 'POST', headers: { 'x-real-ip': '1.1.1.1' }, body: { action: 'register', user: nick, pass: 'correct-horse' } }), res);
  assert.equal(res.statusCode, 200);
  return String(res.headers['set-cookie']).split(';')[0];
}
async function call(method, cookie, body, ct = 'application/json') {
  const res = mockRes();
  const headers = { ...(cookie ? { cookie } : {}), ...(method === 'PUT' && ct ? { 'content-type': ct } : {}) };
  await data(mockReq({ method, headers, body }), res);
  return res;
}
const month = lib.curMonth();
const month2 = lib.shiftMonth(month, 1);
const block = (cat, pct, bank = 'otp') => [{ bank, items: [{ cat, pct }] }];

test('без сессии 401; cookie несуществующего аккаунта на GET тоже 401', async () => {
  assert.equal((await call('GET')).statusCode, 401);
  assert.equal((await call('PUT', null, { parts: {} })).statusCode, 401);
  const ghost = lib.makeCookie('e'.repeat(32)).split(';')[0];
  assert.equal((await call('GET', ghost)).statusCode, 401);
});

test('GET нового аккаунта: ник, пустые данные', async () => {
  const c = await signup('anna');
  const r = await call('GET', c);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { user: 'anna', data: { months: {}, custom: [] }, rev: {} });
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('PUT → GET: данные сохранены, версия части растёт', async () => {
  const c = await signup('anna');
  const key = month;
  const put = await call('PUT', c, { parts: { [key]: { base: 0, value: block('АЗС', '5') } } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.body, { ok: true, rev: { [key]: 1 } });
  const got = await call('GET', c);
  assert.deepEqual(got.body.data.months[month], block('АЗС', '5'));
  assert.equal(got.body.rev[key], 1);
  const put2 = await call('PUT', c, { parts: { [key]: { base: 1, value: block('АЗС', '7') } } });
  assert.deepEqual(put2.body.rev, { [key]: 2 });
});

test('устаревший base → 409 conflict с актуальными данными, запись не происходит', async () => {
  const c = await signup('anna');
  const key = month;
  await call('PUT', c, { parts: { [key]: { base: 0, value: block('АЗС', '5') } } });
  const r = await call('PUT', c, { parts: { [key]: { base: 0, value: block('АЗС', '30') } } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, 'conflict');
  assert.deepEqual(r.body.parts, [key]);
  assert.deepEqual(r.body.data.months[month], block('АЗС', '5'));
});

test('два одновременных PUT с одной версией: один проходит, второй получает conflict', async () => {
  const c = await signup('anna');
  const key = month;
  const rs = await Promise.all([
    call('PUT', c, { parts: { [key]: { base: 0, value: block('АЗС', '5') } } }),
    call('PUT', c, { parts: { [key]: { base: 0, value: block('АЗС', '6') } } }),
  ]);
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409]);
  const got = await call('GET', c);
  assert.equal(got.body.rev[key], 1);
});

test('одновременные PUT разных частей: оба сохраняются (повтор после перечитывания)', async () => {
  const c = await signup('anna');
  const rs = await Promise.all([
    call('PUT', c, { parts: { [month]: { base: 0, value: block('АЗС', '5') } } }),
    call('PUT', c, { parts: { [month2]: { base: 0, value: block('Книги', '3') } } }),
  ]);
  assert.deepEqual(rs.map((r) => r.statusCode), [200, 200]);
  const got = await call('GET', c);
  assert.equal(got.body.data.months[month][0].items[0].cat, 'АЗС');
  assert.equal(got.body.data.months[month2][0].items[0].cat, 'Книги');
});

test('пользователи изолированы: у каждого свой документ', async () => {
  const a = await signup('anna'), b = await signup('boris');
  const key = month;
  await call('PUT', a, { parts: { [key]: { base: 0, value: block('АЗС', '5') } } });
  const rb = await call('GET', b);
  assert.deepEqual(rb.body.data, { months: {}, custom: [] });
  assert.equal((await call('PUT', b, { parts: { [key]: { base: 0, value: block('Книги', '2') } } })).statusCode, 200);
  const ra = await call('GET', a);
  assert.equal(ra.body.data.months[month][0].items[0].cat, 'АЗС');
});

test('проверки запроса: тип содержимого, имя части, окно месяцев, чужие значения отбрасываются', async () => {
  const c = await signup('anna');
  assert.equal((await call('PUT', c, { parts: {} }, 'text/plain')).statusCode, 415);
  assert.equal((await call('PUT', c, { parts: {} })).statusCode, 400);
  assert.equal((await call('PUT', c, { parts: { 'плохо': { base: 0, value: [] } } })).statusCode, 400);
  assert.equal((await call('PUT', c, { parts: { '2000-01': { base: 0, value: [] } } })).statusCode, 400, 'месяц вне окна');
  await call('PUT', c, { parts: { [month]: { base: 0, value: [{ bank: 'evil', items: [] }, ...block('Нет такой', '5'), ...block('АЗС', '999', 'alfa'), ...block('АЗС', '5', 'vtb')] } } });
  const got = await call('GET', c);
  const kept = got.body.data.months[month].flatMap((b) => b.items.map((i) => b.bank + '|' + i.cat + '|' + i.pct));
  assert.deepEqual(kept, ['vtb|АЗС|5'], 'остаются только допустимые банк, категория и процент');
  assert.equal((await call('DELETE', c)).statusCode, 405);
});

test('документ в Redis: ключ doc:<id>, пароль и ник туда не попадают', async () => {
  const c = await signup('qwerty1');
  await call('PUT', c, { parts: { [month]: { base: 0, value: block('АЗС', '5') } } });
  const id = lib.session({ headers: { cookie: c } });
  const raw = __raw('doc:' + id);
  assert.equal(raw.v, '1');
  assert.ok(!raw.d.includes('qwerty1') && !raw.d.includes('correct-horse'));
});

test('Redis недоступен: 500 storage, без падения', async () => {
  const c = await signup('anna');
  __fail('network');
  const r = await call('PUT', c, { parts: { [month]: { base: 0, value: [] } } });
  assert.equal(r.statusCode, 500);
  assert.deepEqual(r.body, { error: 'storage' });
});

test('DB_PREFIX применяется и к документу кэшбэков', async () => {
  process.env.DB_PREFIX = 't:';
  const c = await signup('anna');
  await call('PUT', c, { parts: { [month]: { base: 0, value: block('АЗС', '5') } } });
  const id = lib.session({ headers: { cookie: c } });
  assert.equal(__raw('t:doc:' + id).v, '1');
  assert.equal(__raw('doc:' + id), undefined);
  assert.equal((await call('GET', c)).statusCode, 200);
});

test('формат этапа 2: месяц — массив блоков, имя части без человека; старые имена «месяц:человек» отклоняются', async () => {
  const c = await signup('anna');
  assert.equal((await call('PUT', c, { parts: { [month + ':zhanna']: { base: 0, value: block('АЗС', '5') } } })).statusCode, 400);
  assert.equal((await call('PUT', c, { parts: { [month + ':denis']: { base: 0, value: block('АЗС', '5') } } })).statusCode, 400);
  assert.equal((await call('PUT', c, { parts: { [month]: { base: 0, value: block('АЗС', '5') } } })).statusCode, 200);
  const got = await call('GET', c);
  assert.deepEqual(Object.keys(got.body.data.months), [month]);
  assert.ok(Array.isArray(got.body.data.months[month]));
});

test('документ старого формата (Ж/Д) читается как пустой: месяцы и версии отбрасываются, запись начинается с нуля', async () => {
  const c = await signup('anna');
  const id = lib.session({ headers: { cookie: c } });
  await lib.writeDoc(id, { months: { [month]: { zhanna: block('АЗС', '5'), denis: block('Книги', '3') } }, custom: ['Моя'], rev: { [month + ':zhanna']: 3, custom: 2 } }, null);
  const r = await call('GET', c);
  assert.deepEqual(r.body.data.months, {});
  assert.deepEqual(r.body.data.custom, ['Моя'], 'свои категории сохраняются');
  assert.deepEqual(r.body.rev, { custom: 2 }, 'версии месяцев старого формата отброшены');
  const put = await call('PUT', c, { parts: { [month]: { base: 0, value: block('АЗС', '7') } } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual((await call('GET', c)).body.data.months[month], block('АЗС', '7'));
});

test('в месяце банк не повторяется: второй блок того же банка отбрасывается', async () => {
  const c = await signup('anna');
  const dup = [...block('АЗС', '5', 'otp'), ...block('Книги', '3', 'otp'), ...block('Кафе и рестораны', '2', 'alfa')];
  await call('PUT', c, { parts: { [month]: { base: 0, value: dup } } });
  const got = await call('GET', c);
  assert.deepEqual(got.body.data.months[month].map((b) => b.bank), ['otp', 'alfa']);
});
