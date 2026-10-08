// Эндпоинт api/data.js: доступ по сессии, документы разных пользователей, версии частей, конфликты.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __fail, __raw, __cmdLog } from './redis.mjs';
import { mockReq, mockRes, setEnv, sessionCookie } from './helpers.mjs';

setEnv();
const lib = await import('../api/_lib.js');
const acc = await import('../api/_acc.js');
const data = (await import('../api/data.js')).default;

beforeEach(() => { __reset(); setEnv(); });

const signup = (name) => sessionCookie(acc, lib, name);
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

test('GET нового аккаунта: id, пустое имя, пустые данные', async () => {
  const c = await signup('anna');
  const { id } = await acc.googleAccount('sub-anna', '', 100); // тот же sub: тот же аккаунт
  const r = await call('GET', c);
  assert.equal(r.statusCode, 200);
  assert.match(id, /^[0-9a-f]{32}$/);
  // id нужен сайту для метки «гостевые данные уже сливали» (js/merge.js); берётся из сессии, лишних команд Redis нет
  assert.deepEqual(r.body, { id, name: '', data: { months: {}, custom: [] }, rev: {}, partner: { linked: false } });
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

test('документ в Redis: ключ doc:<id>, имя и почта туда не попадают', async () => {
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

// ---------- кэшбэк партнёра (соединённые аккаунты): только на просмотр ----------
async function pairUp(nameA, nameB, shownB) {
  const a = (await acc.googleAccount('sub-' + nameA, '', 100)).id, b = (await acc.googleAccount('sub-' + nameB, '', 100)).id;
  if (shownB) await acc.setName(b, shownB);
  const t = await acc.createPairToken(a);
  assert.ok(!(await acc.joinPair(t.token, b)).error);
  return { a, b, ca: lib.makeCookie(a).split(';')[0], cb: lib.makeCookie(b).split(';')[0] };
}

test('GET партнёра: имя и месяцы соединённого аккаунта; id, версии и свои категории партнёра сайту не уходят', async () => {
  const p = await pairUp('anna', 'boris', 'Борис');
  await call('PUT', p.cb, { parts: { [month]: { base: 0, value: block('АЗС', '5') }, custom: { base: 0, value: ['Сад'] } } });
  const got = await call('GET', p.ca);
  assert.deepEqual(got.body.partner, { linked: true, name: 'Борис', data: { months: { [month]: block('АЗС', '5') } } });
  assert.ok(!JSON.stringify(got.body).includes(p.b), 'id партнёра не отдаётся');
  assert.deepEqual(got.body.data.months, {}, 'свой документ не смешивается с чужим');
  const back = await call('GET', p.cb);   // связь двусторонняя
  assert.equal(back.body.partner.linked, true);
  assert.deepEqual(back.body.partner.data.months, {});
});

test('партнёр только на просмотр: PUT пишет только документ вызвавшего, документ партнёра не меняется', async () => {
  const p = await pairUp('anna', 'boris');
  await call('PUT', p.cb, { parts: { [month]: { base: 0, value: block('Книги', '3') } } });
  const before = JSON.stringify(__raw('doc:' + p.b));
  const r = await call('PUT', p.ca, { parts: { [month]: { base: 0, value: block('АЗС', '7') } } });
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.stringify(__raw('doc:' + p.b)), before);
  const got = await call('GET', p.ca);
  assert.deepEqual(got.body.data.months[month], block('АЗС', '7'));
  assert.deepEqual(got.body.partner.data.months[month], block('Книги', '3'));
  // id партнёра в теле запроса ни на что не влияет
  await call('PUT', p.ca, { parts: { [month]: { base: 1, value: block('АЗС', '8') } }, user: p.b, of: p.b });
  assert.equal(JSON.stringify(__raw('doc:' + p.b)), before);
});

test('партнёр виден только при полной паре: половинка pair:<id> без ответной записи и после разрыва не считается', async () => {
  const p = await pairUp('anna', 'boris');
  await call('PUT', p.cb, { parts: { [month]: { base: 0, value: block('АЗС', '5') } } });
  assert.equal((await call('GET', p.ca)).body.partner.linked, true);
  await acc.unpair(p.a);
  const got = await call('GET', p.ca);
  assert.deepEqual(got.body.partner, { linked: false });
  assert.ok(!JSON.stringify(got.body).includes('АЗС'));
  assert.deepEqual((await call('GET', p.cb)).body.partner, { linked: false });
});

test('половинка pair:<id> (ответной записи нет): чужой документ не отдаётся', async () => {
  const a = await signup('anna');
  const b = await signup('boris');
  const idA = (await acc.googleAccount('sub-anna', '', 100)).id, idB = (await acc.googleAccount('sub-boris', '', 100)).id;
  await call('PUT', b, { parts: { [month]: { base: 0, value: block('АЗС', '5') } } });
  const { cmd, key } = await import('../api/_db.js');
  await cmd('SET', key('pair', idA), idB);
  const got = await call('GET', a);
  assert.deepEqual(got.body.partner, { linked: false });
  assert.ok(!JSON.stringify(got.body).includes('АЗС'));
});

test('партнёр без документа: пустые месяцы; удалённый аккаунт партнёра: связи нет', async () => {
  const p = await pairUp('anna', 'boris');
  assert.deepEqual((await call('GET', p.ca)).body.partner, { linked: true, name: '', data: { months: {} } });
  await acc.deleteAccount(p.b);
  assert.deepEqual((await call('GET', p.ca)).body.partner, { linked: false });
});

test('расход команд GET: без связи одна лишняя команда (pair:<id>), со связью пара читается один раз', async () => {
  const solo = await signup('solo');
  await call('GET', solo);
  __cmdLog(true);
  await call('GET', solo);
  const base = __cmdLog(true).length;
  const p = await pairUp('anna', 'boris');
  __cmdLog(true);
  await call('GET', p.ca);
  const paired = __cmdLog(true);
  // GET acc:<я>, документ (HGETALL), pair:<я>, pair:<партнёр>, acc:<партнёр>, документ партнёра
  assert.equal(paired.length, 6, JSON.stringify(paired));
  assert.equal(base, 3, 'acc:<я>, документ, pair:<я>');
});
