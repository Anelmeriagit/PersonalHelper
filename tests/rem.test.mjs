// Этап 3b: личные напоминания аккаунта (api/_rem.js, api/reminders.js, api/custom.js, api/recurring.js).
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
// Время в тестах фиксируется через t.mock.timers (Date): 2026-10-10 12:00 по Москве, суббота.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __fail, __keys, __raw, __cmds, __cmdLog } from './redis.mjs';
import { mockReq, mockRes, setEnv, mkAccount } from './helpers.mjs';

setEnv();
const lib = await import('../api/_lib.js');
const acc = await import('../api/_acc.js');
const rem = await import('../api/_rem.js');
const reminders = (await import('../api/reminders.js')).default;
const custom = (await import('../api/custom.js')).default;
const recurring = (await import('../api/recurring.js')).default;

beforeEach(() => { __reset(); setEnv(); });

const NOON = Date.parse('2026-10-10T09:00:00Z'); // 12:00 МСК
const AT = (t, iso = '2026-10-10T09:00:00Z') => t.mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) });
const mkAcc = (name) => mkAccount(acc, name);
const cookieOf = (id) => ({ cookie: lib.makeCookie(id).split(';')[0] });
async function call(h, method, id, body, query) {
  const res = mockRes();
  const req = mockReq({ method, headers: { ...(id ? cookieOf(id) : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body });
  req.query = query || {};
  await h(req, res);
  return res;
}
const post = (h, id, body) => call(h, 'POST', id, body);
const put = (h, id, body) => call(h, 'PUT', id, body);
const del = (h, id, rid) => call(h, 'DELETE', id, undefined, { id: rid });
const get = (id) => call(reminders, 'GET', id);

/* ---------- доступ ---------- */
test('без сессии 401 на все эндпоинты; лишние методы 405; без JSON 415', async () => {
  for (const h of [reminders, custom, recurring]) for (const m of ['GET', 'POST', 'PUT', 'DELETE']) assert.equal((await call(h, m, null)).statusCode, 401);
  const id = await mkAcc('ivan');
  assert.equal((await call(reminders, 'PUT', id, {})).statusCode, 405, 'настройки постоянных ушли');
  assert.equal((await call(reminders, 'POST', id, {})).statusCode, 405);
  assert.equal((await call(custom, 'PATCH', id)).statusCode, 405);
  assert.equal((await call(recurring, 'GET', id)).statusCode, 405);
  const res = mockRes();
  await custom(mockReq({ method: 'POST', headers: { ...cookieOf(id) }, body: 'x' }), res);
  assert.equal(res.statusCode, 415);
});

test('GET нового аккаунта: пусто, Telegram не привязан; no-store; запись в Redis не создаётся', async () => {
  const id = await mkAcc('ivan');
  const r = await get(id);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(r.body, { linked: false, custom: [], recurring: [] });
  assert.ok(!__keys().some((k) => k.startsWith('rem:')));
});

test('linked становится true после привязки Telegram и false после отвязки', async () => {
  const id = await mkAcc('ivan');
  const { token } = await acc.createLinkToken(id);
  await acc.bindTelegram(token, { id: 77, username: 'ivan' }, 77);
  assert.equal((await get(id)).body.linked, true);
  await acc.unlinkTelegram(id);
  assert.equal((await get(id)).body.linked, false);
});

/* ---------- временные ---------- */
test('временное: создание, ответ в нужном виде, запись в rem:<id>, сортировка по дате и слоту', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  assert.equal((await post(custom, id, { date: '2026-10-12', slot: 'evening', text: 'Б' })).statusCode, 200);
  assert.equal((await post(custom, id, { date: '2026-10-12', slot: 'day', text: 'А' })).statusCode, 200);
  const r = await post(custom, id, { date: '2026-10-11', slot: 'evening', text: ' Позвонить  \n' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.linked, false);
  assert.deepEqual(r.body.custom.map((x) => x.text), ['Позвонить', 'А', 'Б']);
  const c = r.body.custom[0];
  assert.deepEqual(Object.keys(c).sort(), ['date', 'id', 'on', 'sent', 'slot', 'text']);
  assert.equal(c.on, true); assert.equal(c.sent, false);
  assert.match(c.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(__keys().filter((k) => k.startsWith('rem:')), ['rem:' + id]);
  assert.ok(!('who' in c));
});

test('временное: проверки входных данных', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  const bad = async (b, code, err) => { const r = await post(custom, id, b); assert.equal(r.statusCode, code, JSON.stringify(b)); assert.equal(r.body.error, err); };
  const ok = { date: '2026-10-15', slot: 'day', text: 'x' };
  await bad({ ...ok, date: '2026-02-30' }, 400, 'bad request');
  await bad({ ...ok, date: 'вчера' }, 400, 'bad request');
  await bad({ ...ok, slot: 'night' }, 400, 'bad request');
  await bad({ ...ok, slot: '__proto__' }, 400, 'bad request');
  await bad({ ...ok, text: '   ' }, 400, 'bad request');
  await bad({ ...ok, text: 'я'.repeat(301) }, 400, 'bad request');
  await bad({ ...ok, date: '2026-10-09' }, 400, 'bad date');
  await bad({ ...ok, date: '2027-12-01' }, 400, 'bad date');
  assert.equal((await post(custom, id, { ...ok, text: 'я'.repeat(300) })).statusCode, 200);
  assert.equal((await post(custom, id, { ...ok, date: '2026-10-10', slot: 'day' })).statusCode, 200, 'в 12:00 слот «после 14:00» ещё свободен');
  assert.equal((await post(custom, id, { ...ok, who: ['p1', 'p2'] })).statusCode, 200, 'поле who просто игнорируется');
  const stored = __raw('rem:' + id);
  assert.ok(!JSON.stringify(stored).includes('who'));
});

test('временное: сегодня поздно для слота («late») и после 18:00', async (t) => {
  AT(t, '2026-10-10T15:00:00Z'); // 18:00 МСК
  const id = await mkAcc('ivan');
  const r = await post(custom, id, { date: '2026-10-10', slot: 'day', text: 'x' });
  assert.equal(r.body.error, 'late');
  assert.equal((await post(custom, id, { date: '2026-10-10', slot: 'evening', text: 'x' })).body.error, 'late');
  assert.equal((await post(custom, id, { date: '2026-10-11', slot: 'day', text: 'x' })).statusCode, 200);
});

test('временное: лимит 50 на аккаунт, у другого аккаунта свой лимит', async (t) => {
  AT(t);
  const a = await mkAcc('anna'), b = await mkAcc('boris');
  for (let i = 0; i < 50; i++) assert.equal((await post(custom, a, { date: '2026-10-20', slot: 'day', text: 'n' + i })).statusCode, 200);
  const r = await post(custom, a, { date: '2026-10-20', slot: 'day', text: 'лишнее' });
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, 'limit');
  assert.equal((await post(custom, b, { date: '2026-10-20', slot: 'day', text: 'ok' })).statusCode, 200);
});

test('временное: вкл/выкл, правка, перенос, удаление, ошибки', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  const one = (await post(custom, id, { date: '2026-10-15', slot: 'day', text: 'старый' })).body.custom[0];
  // выключить
  let r = await put(custom, id, { id: one.id, key: 'on', value: false });
  assert.equal(r.body.custom[0].on, false);
  assert.equal((await put(custom, id, { id: one.id, key: 'on', value: 'нет' })).statusCode, 400);
  assert.equal((await put(custom, id, { id: one.id, key: 'p1', value: true })).statusCode, 400, 'переключателей получателей больше нет');
  assert.equal((await put(custom, id, { id: 'a'.repeat(12), key: 'on', value: true })).statusCode, 404);
  // правка текста
  r = await put(custom, id, { id: one.id, text: ' новый ' });
  assert.equal(r.body.custom[0].text, 'новый');
  // перенос на другую дату и слот
  r = await put(custom, id, { id: one.id, date: '2026-10-20', slot: 'evening' });
  assert.deepEqual([r.body.custom[0].date, r.body.custom[0].slot], ['2026-10-20', 'evening']);
  assert.equal((await put(custom, id, { id: one.id, date: '2026-10-01' })).body.error, 'bad date');
  assert.equal((await put(custom, id, { id: one.id })).statusCode, 400);
  assert.equal((await put(custom, id, { id: one.id, text: '' })).statusCode, 400);
  assert.equal((await put(custom, id, { id: 'zz', text: 'x' })).statusCode, 400);
  assert.equal((await put(custom, id, { id: 'b'.repeat(12), text: 'x' })).statusCode, 404);
  // удаление идемпотентно
  assert.equal((await del(custom, id, one.id)).body.custom.length, 0);
  assert.equal((await get(id)).body.custom.length, 0, 'удалено в хранилище, а не только в ответе');
  assert.equal((await del(custom, id, one.id)).statusCode, 200);
  assert.equal((await del(custom, id, 'плохой')).statusCode, 400);
});

test('временное: после отправки менять нельзя («past»), удалить можно', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  const one = (await post(custom, id, { date: '2026-10-10', slot: 'day', text: 'x' })).body.custom[0];
  const { rem: r0, etag } = await rem.readRem(id);
  r0.custom[0].sent = true;
  await lib.writeRec('rem', id, r0, etag);
  const r = await put(custom, id, { id: one.id, text: 'другое' });
  assert.equal(r.statusCode, 400); assert.equal(r.body.error, 'past');
  assert.equal((await get(id)).body.custom[0].sent, true);
  assert.equal((await del(custom, id, one.id)).body.custom.length, 0);
});

/* ---------- повторяющиеся ---------- */
test('повторяющееся: создание, ближайшая дата, сортировка по ближайшей', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  const mk = (b) => post(recurring, id, { slot: 'day', text: 'x', ...b });
  assert.equal((await mk({ date: '2026-10-10', every: 'week', text: 'сегодня' })).statusCode, 200);
  assert.equal((await mk({ date: '2026-10-05', every: 'week', text: 'с прошлой недели', slot: 'evening' })).statusCode, 400, 'дата отсчёта в прошлом');
  const r = await mk({ date: '2026-10-14', every: '2weeks', text: 'потом' });
  assert.deepEqual(r.body.recurring.map((x) => [x.text, x.next]), [['сегодня', '2026-10-10'], ['потом', '2026-10-14']]);
  assert.deepEqual(Object.keys(r.body.recurring[0]).sort(), ['date', 'every', 'id', 'next', 'on', 'slot', 'text']);
  assert.deepEqual(__keys().filter((k) => k.startsWith('rem:')), ['rem:' + id]);
});

test('повторяющееся: если сегодняшнее уже ушло, ближайшая дата следующая', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  await post(recurring, id, { date: '2026-10-10', every: 'week', slot: 'day', text: 'x' });
  const { rem: r0, etag } = await rem.readRem(id);
  r0.recurring[0].sent['2026-10-10'] = true;
  await lib.writeRec('rem', id, r0, etag);
  assert.equal((await get(id)).body.recurring[0].next, '2026-10-17');
});

test('повторяющееся: проверки входных данных, лимит 30', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  const ok = { date: '2026-10-15', every: 'month', slot: 'day', text: 'x' };
  for (const b of [{ ...ok, every: 'day' }, { ...ok, every: 'constructor' }, { ...ok, slot: 'x' }, { ...ok, text: '' }, { ...ok, date: '15.10.2026' }]) {
    assert.equal((await post(recurring, id, b)).statusCode, 400, JSON.stringify(b));
  }
  assert.equal((await post(recurring, id, { ...ok, date: '2026-10-09' })).body.error, 'bad date');
  for (let i = 0; i < 30; i++) assert.equal((await post(recurring, id, { ...ok, text: 'r' + i })).statusCode, 200);
  const r = await post(recurring, id, ok);
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, 'limit');
});

test('повторяющееся: вкл/выкл, правка (дата отсчёта, частота, время, текст), удаление, ошибки', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  const one = (await post(recurring, id, { date: '2026-10-15', every: 'week', slot: 'day', text: 'раз' })).body.recurring[0];
  assert.equal((await put(recurring, id, { id: one.id, key: 'on', value: false })).body.recurring[0].on, false);
  assert.equal((await put(recurring, id, { id: one.id, key: 'p2', value: true })).statusCode, 400);
  const r = await put(recurring, id, { id: one.id, date: '2026-10-20', every: 'month', slot: 'evening', text: 'два' });
  assert.deepEqual([r.body.recurring[0].date, r.body.recurring[0].every, r.body.recurring[0].slot, r.body.recurring[0].text], ['2026-10-20', 'month', 'evening', 'два']);
  assert.equal((await put(recurring, id, { id: one.id, date: '2026-10-01' })).body.error, 'bad date');
  assert.equal((await put(recurring, id, { id: one.id, every: 'daily' })).statusCode, 400);
  assert.equal((await put(recurring, id, { id: one.id })).statusCode, 400);
  assert.equal((await put(recurring, id, { id: 'c'.repeat(12), text: 'x' })).statusCode, 404);
  assert.equal((await del(recurring, id, one.id)).body.recurring.length, 0);
  assert.equal((await get(id)).body.recurring.length, 0, 'удалено в хранилище, а не только в ответе');
  assert.equal((await del(recurring, id, one.id)).statusCode, 200);
});

/* ---------- изоляция и устойчивость ---------- */
test('изоляция: аккаунты не видят и не меняют чужие напоминания', async (t) => {
  AT(t);
  const a = await mkAcc('anna'), b = await mkAcc('boris');
  const ca = (await post(custom, a, { date: '2026-10-15', slot: 'day', text: 'секрет Анны' })).body.custom[0];
  const ra = (await post(recurring, a, { date: '2026-10-15', every: 'week', slot: 'day', text: 'повтор Анны' })).body.recurring[0];
  const gb = await get(b);
  assert.deepEqual([gb.body.custom, gb.body.recurring], [[], []]);
  assert.equal((await put(custom, b, { id: ca.id, key: 'on', value: false })).statusCode, 404);
  assert.equal((await put(recurring, b, { id: ra.id, text: 'взлом' })).statusCode, 404);
  await del(custom, b, ca.id); await del(recurring, b, ra.id);
  const ga = await get(a);
  assert.equal(ga.body.custom.length, 1); assert.equal(ga.body.custom[0].on, true);
  assert.equal(ga.body.recurring[0].text, 'повтор Анны');
  assert.ok(!JSON.stringify(__raw('rem:' + b) || '').includes('Анны'));
});

test('испорченные и чужие по форме записи в Redis отбрасываются, остальное остаётся', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  await lib.writeRec('rem', id, {
    custom: [
      { id: 'a'.repeat(12), date: '2026-10-15', slot: 'day', text: 'норм', on: true, sent: false, who: ['p1'] },
      { id: 'плохой', date: '2026-10-15', slot: 'day', text: 'x' },
      { id: 'b'.repeat(12), date: '2026-13-45', slot: 'day', text: 'x' },
      { id: 'c'.repeat(12), date: '2026-10-15', slot: 'night', text: 'x' },
      null, 5,
    ],
    recurring: [{ id: 'd'.repeat(12), date: '2026-10-15', every: 'week', slot: 'day', text: 'р', sent: { '2026-10-01': ['p1'], 'мусор': true } }],
    cycles: { 'halva:2026-10': {} }, settings: { halva: { on: false } },
  }, null);
  const r = await get(id);
  assert.deepEqual(r.body.custom.map((x) => x.text), ['норм']);
  assert.equal(r.body.recurring.length, 1);
  // при первой записи лишнее (who, cycles, settings) уходит
  await put(custom, id, { id: 'a'.repeat(12), key: 'on', value: false });
  const stored = JSON.stringify(__raw('rem:' + id));
  for (const w of ['who', 'cycles', 'settings', 'p1', 'мусор']) assert.ok(!stored.includes(w), w);
});

test('сбой Redis: 500 без подробностей', async (t) => {
  t.mock.method(console, 'error', () => {});
  const id = await mkAcc('ivan');
  __fail('http');
  for (const r of [await get(id), await post(custom, id, { date: '2026-10-15', slot: 'day', text: 'x' }), await del(recurring, id, 'a'.repeat(12))]) {
    assert.equal(r.statusCode, 500);
    assert.deepEqual(r.body, { error: 'storage' });
  }
});

test('одновременные создания не теряют друг друга (CAS с повторами)', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  const rs = await Promise.all([1, 2, 3, 4].map((i) => post(custom, id, { date: '2026-10-15', slot: 'day', text: 'п' + i })));
  assert.deepEqual(rs.map((r) => r.statusCode), [200, 200, 200, 200]);
  assert.deepEqual((await get(id)).body.custom.map((x) => x.text).sort(), ['п1', 'п2', 'п3', 'п4']);
});

/* ---------- расписание: planRem и unclaimRem ---------- */
const mk = (o) => rem.normRem(o);
const C = (n, o) => ({ id: n.repeat(12).slice(0, 12), date: '2026-10-10', slot: 'day', text: 'т' + n, on: true, sent: false, ...o });
const R = (n, o) => ({ id: n.repeat(12).slice(0, 12), date: '2026-10-03', every: 'week', slot: 'day', text: 'р' + n, on: true, sent: {}, ...o });
const NOW = { month: '2026-10', date: '2026-10-10' };

test('planRem: временное уходит один раз в своём слоте', () => {
  const r = mk({ custom: [C('a'), C('b', { slot: 'evening' }), C('c', { date: '2026-10-11' }), C('d', { on: false }), C('e', { sent: true })] });
  const day = rem.planRem(r, NOW, 'day');
  assert.deepEqual(day.map((x) => [x.kind, x.text]), [['custom', 'тa']]);
  assert.equal(r.custom.find((x) => x.text === 'тa').sent, true);
  assert.deepEqual(rem.planRem(r, NOW, 'day'), [], 'повторный запуск не дублирует');
  assert.deepEqual(rem.planRem(r, NOW, 'evening').map((x) => x.text), ['тb']);
  assert.equal(r.custom.find((x) => x.text === 'тc').sent, false, 'завтрашнее не тронуто');
  assert.equal(r.custom.find((x) => x.text === 'тd').sent, false, 'выключенное не тронуто');
});

test('planRem: повторяющиеся по неделям, двум неделям и месяцу; отметка по дате', () => {
  const r = mk({ recurring: [R('a'), R('b', { every: '2weeks' }), R('c', { every: 'month', date: '2026-08-31' })] });
  assert.deepEqual(rem.planRem(r, NOW, 'day').map((x) => x.text), ['рa'], '10 окт: неделя от 3 окт (7 дней) да; две недели нет; месяц (31-е) нет');
  assert.deepEqual(rem.planRem(r, NOW, 'day'), []);
  assert.deepEqual(rem.planRem(r, { month: '2026-10', date: '2026-10-17' }, 'day').map((x) => x.text), ['рa', 'рb']);
  assert.deepEqual(rem.planRem(r, { month: '2026-11', date: '2026-11-30' }, 'day').map((x) => x.text), ['рc'], 'в ноябре 31-го нет: последний день месяца');
  assert.deepEqual(rem.planRem(mk({ recurring: [R('a', { on: false })] }), NOW, 'day'), []);
  assert.deepEqual(rem.planRem(mk({ recurring: [R('a', { date: '2026-10-11' })] }), NOW, 'day'), [], 'до даты отсчёта не срабатывает');
  assert.deepEqual(rem.planRem(mk({ recurring: [R('a', { slot: 'evening' })] }), NOW, 'day'), []);
});

test('planRem: без слота (сухой прогон) берёт оба слота', () => {
  const r = mk({ custom: [C('a'), C('b', { slot: 'evening' })] });
  assert.equal(rem.planRem(r, NOW).length, 2);
});

test('unclaimRem: после сбоя отметки снимаются и отправка повторится', () => {
  const r = mk({ custom: [C('a')], recurring: [R('b')] });
  const plan = rem.planRem(r, NOW, 'day');
  assert.equal(plan.length, 2);
  rem.unclaimRem(r, plan.filter((x) => x.kind === 'rec'));
  assert.deepEqual(rem.planRem(r, NOW, 'day').map((x) => x.kind), ['rec'], 'повторяющееся вернулось, временное осталось отправленным');
  rem.unclaimRem(r, plan);
  assert.equal(r.custom[0].sent, false);
  assert.deepEqual(r.recurring[0].sent, {});
});

test('planRem: старые временные (старше 60 дней) и старые отметки повторяющихся чистятся', () => {
  const r = mk({ custom: [C('a', { date: '2026-08-10' }), C('b', { date: '2026-08-11' })], recurring: [R('c', { sent: { '2026-08-01': true, '2026-09-30': true } })] });
  rem.planRem(r, NOW, 'day');
  assert.deepEqual(r.custom.map((x) => x.text), ['тb'], '10 августа ровно 61 день назад — удалено, 11 августа остаётся');
  assert.ok(!('2026-08-01' in r.recurring[0].sent)); assert.ok('2026-09-30' in r.recurring[0].sent);
});

test('mutateRem: ошибка внутри fn ничего не пишет; без изменений запись не создаётся', async () => {
  const id = await mkAcc('ivan');
  const r1 = await rem.mutateRem(id, () => {});
  assert.deepEqual(r1.rem, { custom: [], recurring: [] });
  assert.ok(!__keys().some((k) => k.startsWith('rem:')));
  const r2 = await rem.mutateRem(id, () => ({ err: 'x' }));
  assert.equal(r2.err, 'x');
  assert.ok(!__keys().some((k) => k.startsWith('rem:')));
});

/* ---------- username в ответе и число команд Redis (сокращение расхода Upstash) ---------- */
test('GET /api/reminders у привязанного отдаёт username без @, у не привязанного поля username нет', async () => {
  const id = await mkAcc('ivan');
  assert.ok(!('username' in (await get(id)).body), 'не привязан: без username');
  const { token } = await acc.createLinkToken(id);
  await acc.bindTelegram(token, { id: 77, username: 'ivan_k' }, 77);
  const r = await get(id);
  assert.equal(r.body.linked, true);
  assert.equal(r.body.username, 'ivan_k');
  await acc.unlinkTelegram(id);
  assert.ok(!('username' in (await get(id)).body), 'после отвязки username пропадает');
});

test('привязка без username: linked true, username пустая строка', async () => {
  const id = await mkAcc('ivan');
  const { token } = await acc.createLinkToken(id);
  await acc.bindTelegram(token, { id: 78 }, 78);
  const r = await get(id);
  assert.equal(r.body.linked, true);
  assert.equal(r.body.username, '');
});

test('GET /api/reminders: три команды Redis (одна из них проверка связи), запись tg:<id> читается один раз', async () => {
  const id = await mkAcc('ivan');
  const { token } = await acc.createLinkToken(id);
  await acc.bindTelegram(token, { id: 77, username: 'ivan_k' }, 77);
  __cmdLog(true);
  const r = await get(id);
  assert.equal(r.statusCode, 200);
  const log = __cmdLog();
  assert.equal(log.length, 3, 'команды: ' + log.join(' | '));
  assert.equal(log.filter((c) => c === 'GET tg:' + id).length, 1, 'tg:<id> читается один раз: ' + log.join(' | '));
  assert.equal(log.filter((c) => c === 'HMGET rem:' + id).length, 1);
  assert.equal(log.filter((c) => c === 'GET pair:' + id).length, 1, 'без связи только один GET pair: ' + log.join(' | '));
  assert.equal(__cmds(), 3);
});

test('POST /api/custom тоже отдаёт username (клиент заменяет rem целиком, блок Telegram не теряет имя)', async () => {
  const id = await mkAcc('ivan');
  const { token } = await acc.createLinkToken(id);
  await acc.bindTelegram(token, { id: 77, username: 'ivan_k' }, 77);
  const r = await post(custom, id, { date: '2026-10-12', slot: 'day', text: 'позвонить' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.username, 'ivan_k');
});

/* ---------- часовая сетка слотов h07…h23 ---------- */
test('сетка слотов: допустимы h07…h23 и старые day/evening, остальное отклоняется', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  const ok = { date: '2026-10-15', text: 'x' };
  assert.deepEqual(Object.keys(rem.SLOT_MIN).length, 34 + 2);
  for (const slot of ['h07', 'h15', 'h23', 'h07m30', 'h15m30', 'h23m30', 'day', 'evening']) assert.equal((await post(custom, id, { ...ok, slot })).statusCode, 200, slot);
  for (const slot of ['h06', 'h06m30', 'h24', 'h24m30', 'h7', 'H15', '15', 'h15 ', 'h15m00', 'h15m15', 'h15m45', 'h15m3', 'h15m30 ', 'constructor']) assert.equal((await post(custom, id, { ...ok, slot })).body.error, 'bad request', slot);
  const rr = await post(recurring, id, { date: '2026-10-15', every: 'week', slot: 'h09', text: 'р' });
  assert.equal(rr.statusCode, 200);
  assert.equal(rr.body.recurring[0].slot, 'h09');
});

test('сетка слотов: «late» по часу слота, сегодня в 12:00 доступны h13 и позже', async (t) => {
  AT(t); // 12:00 МСК
  const id = await mkAcc('ivan');
  const today = (slot) => post(custom, id, { date: '2026-10-10', slot, text: 'x' });
  assert.equal((await today('h07')).body.error, 'late');
  assert.equal((await today('h12')).body.error, 'late', 'в 12:00 слот «после 12:00» уже начался');
  assert.equal((await today('h13')).statusCode, 200);
  assert.equal((await today('h23')).statusCode, 200);
  const one = (await post(custom, id, { date: '2026-10-15', slot: 'h20', text: 'y' })).body.custom.find((c) => c.text === 'y');
  assert.equal((await call(custom, 'PUT', id, { id: one.id, date: '2026-10-10', slot: 'h09' })).body.error, 'late', 'правка тоже проверяет час');
  assert.equal((await call(custom, 'PUT', id, { id: one.id, slot: 'h21' })).statusCode, 200);
});

test('сетка слотов: список сортируется по дате и часу, старые слоты равны своим часам', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  for (const slot of ['h22', 'evening', 'h08', 'day', 'h15']) await post(custom, id, { date: '2026-10-12', slot, text: slot });
  const r = await call(reminders, 'GET', id);
  assert.deepEqual(r.body.custom.map((c) => c.text), ['h08', 'day', 'h15', 'evening', 'h22'], 'day = 14:00, evening = 18:00');
});

test('planRem: слот сетки совпадает со старым по часу (cron «day» берёт h14, «evening» берёт h18)', () => {
  const r = mk({ custom: [C('a', { slot: 'h14' }), C('b', { slot: 'day' }), C('c', { slot: 'h15' }), C('d', { slot: 'h18' }), C('e', { slot: 'evening' })] });
  assert.deepEqual(rem.planRem(r, NOW, 'day').map((x) => x.text).sort(), ['тa', 'тb']);
  assert.deepEqual(rem.planRem(r, NOW, 'evening').map((x) => x.text).sort(), ['тd', 'тe']);
  assert.equal(r.custom.find((x) => x.text === 'тc').sent, false, 'h15 в эти слоты не попал');
  const rr = mk({ recurring: [R('a', { slot: 'h14' }), R('b', { slot: 'h09' })] });
  assert.deepEqual(rem.planRem(rr, NOW, 'day').map((x) => x.text), ['рa']);
});

test('planRem по часу: всё, чей час наступил (с догонянием), без slot; slot — ровно один час; без часа — весь день', () => {
  const mkR = () => mk({ custom: [C('a', { slot: 'h07' }), C('b', { slot: 'day' }), C('c', { slot: 'h15' }), C('d', { slot: 'evening' }), C('e', { slot: 'h23' })], recurring: [R('f', { slot: 'h09' }), R('1', { slot: 'h20' })] });
  const names = (r, now, slot) => rem.planRem(r, now, slot).map((x) => x.text).sort();
  assert.deepEqual(names(mkR(), { ...NOW, hour: 6 }), [], 'до 07:00 ничего');
  assert.deepEqual(names(mkR(), { ...NOW, hour: 7 }), ['тa']);
  assert.deepEqual(names(mkR(), { ...NOW, hour: 14 }), ['рf', 'тa', 'тb'], 'день: утреннее догоняется');
  assert.deepEqual(names(mkR(), { ...NOW, hour: 18 }), ['рf', 'тa', 'тb', 'тc', 'тd']);
  assert.deepEqual(names(mkR(), { ...NOW, hour: 23 }), ['р1', 'рf', 'тa', 'тb', 'тc', 'тd', 'тe']);
  assert.equal(names(mkR(), NOW).length, 7, 'без часа (сухой прогон с date) — весь день');
  assert.deepEqual(names(mkR(), { ...NOW, hour: 7 }, 'h23'), ['тe'], 'slot — ровно этот час, время суток не смотрим');
  const r = mkR();
  assert.equal(rem.planRem(r, { ...NOW, hour: 14 }).length, 3);
  assert.deepEqual(rem.planRem(r, { ...NOW, hour: 14 }), [], 'повтор не дублирует');
  assert.deepEqual(rem.planRem(r, { ...NOW, hour: 16 }).map((x) => x.text), ['тc'], 'следующий запуск добирает только новое');
  assert.equal(rem.planRem(mkR(), { month: '2026-10', date: '2026-10-17', hour: 23 }).length, 2, 'другой день: временные на 10 окт не идут, повторяющиеся (неделя от 3 окт) идут');
});

test('planShr по часу: то же для общих, отдельно по сторонам', () => {
  const shr = () => rem.normShr({ custom: ['h08', 'h14', 'h16'].map((slot, i) => ({ id: 'abcdef00000' + i, date: '2026-10-10', slot, text: 'о' + i, on: { a: true, b: true }, sent: { a: false, b: false } })) });
  const s = shr();
  assert.deepEqual(rem.planShr(s, { ...NOW, hour: 14 }, undefined, 'a').map((x) => x.text), ['о0', 'о1']);
  assert.deepEqual(rem.planShr(s, { ...NOW, hour: 14 }, undefined, 'a'), []);
  assert.deepEqual(rem.planShr(s, { ...NOW, hour: 14 }, undefined, 'b').map((x) => x.text), ['о0', 'о1'], 'сторона b не затронута');
  assert.deepEqual(rem.planShr(s, { ...NOW, hour: 16 }, undefined, 'a').map((x) => x.text), ['о2']);
  assert.deepEqual(rem.planShr(shr(), { ...NOW, hour: 16 }, 'h16', 'a').map((x) => x.text), ['о2'], 'slot — ровно этот час');
});

test('mskNow: дата, месяц и час по Москве; время берётся из Date.now', (t) => {
  assert.deepEqual(rem.mskNow(new Date('2026-10-14T20:59:59Z')), { month: '2026-10', date: '2026-10-14', hour: 23, minute: 59 });
  assert.deepEqual(rem.mskNow(new Date('2026-10-14T21:00:00Z')), { month: '2026-10', date: '2026-10-15', hour: 0, minute: 0 });
  t.mock.method(Date, 'now', () => Date.parse('2026-10-31T21:30:00Z'));
  assert.deepEqual(rem.mskNow(), { month: '2026-11', date: '2026-11-01', hour: 0, minute: 30 });
});

/* ---------- минуты: слоты HH:30 (h07m30 … h23m30) ---------- */
test('минутные слоты: «late» по минутам, в 12:00 доступен h12m30, h12 уже нет; правка проверяет то же', async (t) => {
  AT(t); // 12:00 МСК
  const id = await mkAcc('ivan');
  const today = (slot) => post(custom, id, { date: '2026-10-10', slot, text: 'x' });
  assert.equal((await today('h12')).body.error, 'late');
  assert.equal((await today('h11m30')).body.error, 'late');
  assert.equal((await today('h12m30')).statusCode, 200);
  assert.equal((await today('h23m30')).statusCode, 200);
  const rr = await post(recurring, id, { date: '2026-10-10', every: 'week', slot: 'h12', text: 'р' });
  assert.equal(rr.body.error, 'late');
  assert.equal((await post(recurring, id, { date: '2026-10-10', every: 'week', slot: 'h12m30', text: 'р' })).statusCode, 200);
  const one = (await post(custom, id, { date: '2026-10-15', slot: 'h20', text: 'y' })).body.custom.find((c) => c.text === 'y');
  assert.equal((await call(custom, 'PUT', id, { id: one.id, date: '2026-10-10', slot: 'h11m30' })).body.error, 'late');
  assert.equal((await call(custom, 'PUT', id, { id: one.id, slot: 'h20m30' })).statusCode, 200);
  assert.equal((await call(reminders, 'GET', id)).body.custom.find((c) => c.text === 'y').slot, 'h20m30', 'слот с минутами сохраняется как есть');
});

test('минутные слоты: список сортируется по времени, hXXm30 между hXX и hXX+1', async (t) => {
  AT(t);
  const id = await mkAcc('ivan');
  for (const slot of ['h15', 'h14m30', 'evening', 'h08m30', 'day', 'h08', 'h23m30']) await post(custom, id, { date: '2026-10-12', slot, text: slot });
  const r = await call(reminders, 'GET', id);
  assert.deepEqual(r.body.custom.map((c) => c.text), ['h08', 'h08m30', 'day', 'h14m30', 'h15', 'evening', 'h23m30']);
});

test('planRem по минутам: h14m30 уходит с 14:30, не раньше; без минут в now считается :00; slot — ровно это время', () => {
  const mkR = () => mk({ custom: [C('a', { slot: 'h14' }), C('b', { slot: 'h14m30' }), C('c', { slot: 'h15' })], recurring: [R('d', { slot: 'h14m30' })] });
  const names = (r, now, slot) => rem.planRem(r, now, slot).map((x) => x.text).sort();
  assert.deepEqual(names(mkR(), { ...NOW, hour: 14, minute: 29 }), ['тa']);
  assert.deepEqual(names(mkR(), { ...NOW, hour: 14, minute: 30 }), ['рd', 'тa', 'тb']);
  assert.deepEqual(names(mkR(), { ...NOW, hour: 14 }), ['тa'], 'минут нет в now — это :00');
  assert.deepEqual(names(mkR(), { ...NOW, hour: 15, minute: 0 }), ['рd', 'тa', 'тb', 'тc']);
  assert.deepEqual(names(mkR(), { ...NOW, hour: 7 }, 'h14m30'), ['рd', 'тb'], 'slot h14m30 не берёт h14 и h15');
  assert.deepEqual(names(mkR(), { ...NOW, hour: 7 }, 'h14'), ['тa'], 'slot h14 не берёт h14m30');
  assert.deepEqual(names(mkR(), NOW).length, 4, 'без часа — весь день');
  const r = mkR();
  assert.equal(rem.planRem(r, { ...NOW, hour: 14, minute: 40 }).length, 3);
  assert.deepEqual(rem.planRem(r, { ...NOW, hour: 14, minute: 50 }), [], 'повтор не дублирует');
});

test('planShr по минутам: то же для общих', () => {
  const s = rem.normShr({ custom: ['h14', 'h14m30', 'h15'].map((slot, i) => ({ id: 'abcdef00000' + i, date: '2026-10-10', slot, text: 'о' + i, on: { a: true, b: true }, sent: { a: false, b: false } })) });
  assert.deepEqual(rem.planShr(s, { ...NOW, hour: 14, minute: 20 }, undefined, 'a').map((x) => x.text), ['о0']);
  assert.deepEqual(rem.planShr(s, { ...NOW, hour: 14, minute: 30 }, undefined, 'a').map((x) => x.text), ['о1']);
  assert.deepEqual(rem.planShr(s, { ...NOW, hour: 14, minute: 30 }, undefined, 'b').map((x) => x.text), ['о0', 'о1'], 'сторона b не затронута');
});

test('нормализация: слот вне сетки отбрасывает запись, слот сетки сохраняется как есть', () => {
  const n = rem.normRem({ custom: [C('a', { slot: 'h06' }), C('b', { slot: 'h23' }), C('c', { slot: 'day' })], recurring: [R('d', { slot: 'h24' }), R('e', { slot: 'h07' })] });
  assert.deepEqual(n.custom.map((x) => [x.text, x.slot]), [['тb', 'h23'], ['тc', 'day']]);
  assert.deepEqual(n.recurring.map((x) => [x.text, x.slot]), [['рe', 'h07']]);
});
