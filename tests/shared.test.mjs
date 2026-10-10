// Соединить аккаунты, часть 4: общие напоминания пары (shr:<меньший id>:<больший id>) в api/_rem.js, custom.js, recurring.js, reminders.js, cron.js,
// разрыв связи и удаление аккаунта в api/_acc.js, вид ключа shr в api/_backup.js. Заглушка Redis и мок-fetch к Telegram.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __keys, __raw, __cmdLog } from './redis.mjs';
import { mockReq, mockRes, setEnv, mkAccount, linkUser, pinMsk } from './helpers.mjs';

setEnv();
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.CRON_SECRET = 'test-cron-secret';
const lib = await import('../api/_lib.js');
const acc = await import('../api/_acc.js');
const rem = await import('../api/_rem.js');
const { dueAll } = await import('../api/_due.js');
const { reindexAccount } = await import('../api/_reindex.js');
const backup = await import('../api/_backup.js');
const reminders = (await import('../api/reminders.js')).default;
const custom = (await import('../api/custom.js')).default;
const recurring = (await import('../api/recurring.js')).default;
const cron = (await import('../api/cron.js')).default;

beforeEach(() => { __reset(); setEnv(); process.env.TELEGRAM_BOT_TOKEN = 'test-token'; process.env.CRON_SECRET = 'test-cron-secret'; });

const AT = (t, iso = '2026-10-10T09:00:00Z') => t.mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) }); // 12:00 МСК, суббота
const cookieOf = (id) => ({ cookie: lib.makeCookie(id).split(';')[0] });
async function call(h, method, id, body, query) {
  const res = mockRes();
  const req = mockReq({ method, headers: { ...(id ? cookieOf(id) : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body });
  req.query = query || {};
  await h(req, res);
  return res;
}
const get = (id) => call(reminders, 'GET', id);
const post = (h, id, body) => call(h, 'POST', id, body);
const put = (h, id, body) => call(h, 'PUT', id, body);
const del = (h, id, rid, shared) => call(h, 'DELETE', id, undefined, { id: rid, ...(shared ? { shared: '1' } : {}) });

// Два аккаунта в связи. → { a, b } (a — не обязательно «a» сторона: сторону даёт rem.sideOf)
async function mkPair(n1 = 'anna', n2 = 'boris') {
  const a = await mkAccount(acc, n1), b = await mkAccount(acc, n2);
  const { token } = await acc.createPairToken(a);
  const r = await acc.joinPair(token, b);
  assert.equal(r.id, a);
  return { a, b };
}
const shrKey = (a, b) => 'shr:' + acc.pairId(a, b);

/* ---------- доступ и форма ответа ---------- */
test('без связи: ответ без shared, shared-запросы 409 nopair, ничего не пишется', async (t) => {
  AT(t);
  const a = await mkAccount(acc, 'anna');
  assert.deepEqual((await get(a)).body, { linked: false, custom: [], recurring: [] });
  for (const [h, body] of [[custom, { date: '2026-10-12', slot: 'day', text: 'x', shared: true }], [recurring, { date: '2026-10-12', every: 'week', slot: 'day', text: 'x', shared: true }]]) {
    const r = await post(h, a, body);
    assert.deepEqual([r.statusCode, r.body], [409, { error: 'nopair' }]);
  }
  assert.equal((await put(custom, a, { id: '0'.repeat(12), key: 'on', value: false, shared: true })).statusCode, 409);
  assert.equal((await del(custom, a, '0'.repeat(12), true)).statusCode, 409);
  assert.equal((await del(recurring, a, '0'.repeat(12), true)).statusCode, 409);
  assert.ok(!__keys().some((k) => k.startsWith('shr:')));
});

test('половина пары (ответной записи нет) связью не считается', async (t) => {
  AT(t);
  const a = await mkAccount(acc, 'anna'), b = await mkAccount(acc, 'boris');
  await acc.createPairToken(a);
  const { cmd } = await import('../api/_db.js');
  await cmd('SET', 'pair:' + a, b);
  assert.equal((await post(custom, a, { date: '2026-10-12', slot: 'day', text: 'x', shared: true })).statusCode, 409);
  assert.equal((await get(a)).body.shared, undefined);
});

test('общее временное: создаёт любой из двоих, обе галочки включены, виден обоим одинаково, запись одна на пару', async (t) => {
  AT(t);
  const { a, b } = await mkPair();
  const r = await post(custom, a, { date: '2026-10-12', slot: 'evening', text: 'Купить молоко', shared: true });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.custom, [], 'личный список не тронут');
  const sa = r.body.shared;
  assert.equal(sa.linked, true);
  assert.equal(sa.name, '', 'имя партнёра не задано');
  assert.equal(sa.custom.length, 1);
  assert.deepEqual({ ...sa.custom[0], id: 'x' }, { id: 'x', date: '2026-10-12', slot: 'evening', text: 'Купить молоко', on: true, pon: true, sent: false, psent: false });
  const sb = (await get(b)).body.shared;
  assert.deepEqual(sb.custom, sa.custom);
  assert.deepEqual((await get(b)).body.custom, [], 'у партнёра личный список пуст');
  assert.deepEqual(__keys().filter((k) => k.startsWith('shr:')), [shrKey(a, b)]);
  assert.ok(!__keys().some((k) => k === 'rem:' + a || k === 'rem:' + b), 'личные записи не созданы');
  // партнёр создаёт своё в ту же запись
  assert.equal((await post(custom, b, { date: '2026-10-11', slot: 'day', text: 'От Бориса', shared: true })).body.shared.custom.length, 2);
  assert.equal((await get(a)).body.shared.custom.map((x) => x.text).join(), 'От Бориса,Купить молоко', 'сортировка по дате');
});

test('имя партнёра в shared.name', async () => {
  const { a, b } = await mkPair();
  await acc.setName(b, 'Борис');
  await acc.setName(a, 'Анна');
  assert.equal((await get(a)).body.shared.name, 'Борис');
  assert.equal((await get(b)).body.shared.name, 'Анна');
});

test('чужой аккаунт общих напоминаний пары не видит и не меняет; shared: false пишет в личные', async (t) => {
  AT(t);
  const { a, b } = await mkPair();
  const c = await mkAccount(acc, 'clara');
  const r = await post(custom, a, { date: '2026-10-12', slot: 'day', text: 'секрет пары', shared: true });
  const id = r.body.shared.custom[0].id;
  assert.equal((await get(c)).body.shared, undefined);
  assert.equal(JSON.stringify((await get(c)).body).includes('секрет'), false);
  assert.equal((await put(custom, c, { id, key: 'on', value: false, shared: true })).statusCode, 409);
  assert.equal((await del(custom, c, id, true)).statusCode, 409);
  // без shared запрос идёт в личные: id пары там не находится
  assert.equal((await put(custom, a, { id, key: 'on', value: false })).statusCode, 404);
  assert.equal((await del(custom, a, id)).statusCode, 200);
  assert.equal((await get(b)).body.shared.custom.length, 1, 'общее не удалено запросом без shared');
  await post(custom, a, { date: '2026-10-12', slot: 'day', text: 'личное' });
  assert.deepEqual((await get(b)).body.custom, []);
  assert.equal((await get(a)).body.custom.length, 1);
});

test('галочки: своя и партнёра меняются отдельно, у каждого вид «on — моя, pon — партнёра»', async (t) => {
  AT(t);
  const { a, b } = await mkPair();
  const id = (await post(custom, a, { date: '2026-10-12', slot: 'day', text: 'x', shared: true })).body.shared.custom[0].id;
  let r = await put(custom, a, { id, key: 'on', value: false, shared: true });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.shared.custom[0].on, r.body.shared.custom[0].pon], [false, true]);
  let rb = (await get(b)).body.shared.custom[0];
  assert.deepEqual([rb.on, rb.pon], [true, false], 'у партнёра наоборот');
  // партнёр выключает чужую галочку
  r = await put(custom, b, { id, key: 'on', value: false, who: 'partner', shared: true });
  assert.deepEqual([r.body.shared.custom[0].on, r.body.shared.custom[0].pon], [true, false]);
  r = await put(custom, b, { id, key: 'on', value: true, who: 'me', shared: true });
  assert.deepEqual([r.body.shared.custom[0].on, r.body.shared.custom[0].pon], [true, false], 'своя галочка Бориса включена, Анны по-прежнему выключена');
  r = await put(custom, a, { id, key: 'on', value: true, who: 'me', shared: true });
  assert.deepEqual([r.body.shared.custom[0].on, r.body.shared.custom[0].pon], [true, true]);
  assert.equal((await put(custom, b, { id, key: 'on', value: true, who: 'они', shared: true })).statusCode, 400);
  assert.equal((await put(custom, b, { id, key: 'on', value: 'нет', shared: true })).statusCode, 400);
});

test('общее временное: правка текста и переноса, 400 past после отправки хотя бы одному, лимит 50, удаление у обоих', async (t) => {
  AT(t);
  const { a, b } = await mkPair();
  const id = (await post(custom, a, { date: '2026-10-12', slot: 'day', text: 'старое', shared: true })).body.shared.custom[0].id;
  const r = await put(custom, b, { id, text: 'новое', date: '2026-10-15', slot: 'evening', shared: true });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.shared.custom[0].text, r.body.shared.custom[0].date, r.body.shared.custom[0].slot], ['новое', '2026-10-15', 'evening']);
  assert.equal((await put(custom, a, { id, date: '2026-10-09', shared: true })).body.error, 'bad date');
  assert.equal((await put(custom, a, { id: '1'.repeat(12), text: 'x', shared: true })).statusCode, 404);
  await rem.mutateShr(a, b, (s) => { s.custom[0].sent[rem.sideOf(b, a)] = true; });
  assert.equal((await put(custom, a, { id, text: 'после отправки', shared: true })).body.error, 'past');
  assert.equal((await del(custom, b, id, true)).body.shared.custom.length, 0);
  assert.equal((await get(a)).body.shared.custom.length, 0);
  for (let i = 0; i < 50; i++) await post(custom, a, { date: '2026-10-12', slot: 'day', text: 'n' + i, shared: true });
  const full = await post(custom, b, { date: '2026-10-12', slot: 'day', text: 'лишнее', shared: true });
  assert.deepEqual([full.statusCode, full.body.error], [409, 'limit']);
  assert.equal((await post(custom, a, { date: '2026-10-12', slot: 'day', text: 'личное' })).statusCode, 200, 'лимит общих личные не трогает');
});

test('общее повторяющееся: создание, галочки, правка, ближайшая дата зависит от своей отметки', async (t) => {
  AT(t);
  const { a, b } = await mkPair();
  const r = await post(recurring, a, { date: '2026-10-10', every: 'week', slot: 'evening', text: 'Мусор', shared: true });
  assert.equal(r.statusCode, 200);
  const it = r.body.shared.recurring[0];
  assert.deepEqual([it.text, it.every, it.on, it.pon, it.next], ['Мусор', 'week', true, true, '2026-10-10']);
  const sa = rem.sideOf(a, b);
  await rem.mutateShr(a, b, (s) => { s.recurring[0].sent['2026-10-10'] = { a: false, b: false, [sa]: true }; });
  assert.equal((await get(a)).body.shared.recurring[0].next, '2026-10-17', 'моя отметка за сегодня стоит');
  assert.equal((await get(b)).body.shared.recurring[0].next, '2026-10-10', 'у партнёра нет');
  const e = await put(recurring, b, { id: it.id, text: 'Вынести мусор', every: '2weeks', shared: true });
  assert.deepEqual([e.body.shared.recurring[0].text, e.body.shared.recurring[0].every], ['Вынести мусор', '2weeks']);
  const o = await put(recurring, b, { id: it.id, key: 'on', value: false, who: 'partner', shared: true });
  assert.deepEqual([o.body.shared.recurring[0].on, o.body.shared.recurring[0].pon], [true, false], 'Борис выключил галочку Анны');
  assert.deepEqual([(await get(a)).body.shared.recurring[0].on, (await get(a)).body.shared.recurring[0].pon], [false, true]);
  assert.equal((await del(recurring, a, it.id, true)).body.shared.recurring.length, 0);
  for (let i = 0; i < 30; i++) await post(recurring, a, { date: '2026-10-12', every: 'month', slot: 'day', text: 'r' + i, shared: true });
  assert.equal((await post(recurring, b, { date: '2026-10-12', every: 'month', slot: 'day', text: 'лишнее', shared: true })).body.error, 'limit');
});

/* ---------- нормализация ---------- */
test('normShr: чужие поля и мусор отбрасываются, галочки по умолчанию включены, отметки только явное true', () => {
  const n = rem.normShr({
    custom: [
      { id: 'aaaaaaaaaaaa', date: '2026-10-12', slot: 'day', text: 'ok', on: { a: false }, sent: { a: true, b: 'yes' }, extra: 1 },
      { id: 'bad', date: '2026-10-12', slot: 'day', text: 'bad id' },
    ],
    recurring: [{ id: 'bbbbbbbbbbbb', date: '2026-10-12', every: 'week', slot: 'day', text: 'r', sent: { '2026-10-12': { b: true }, '2026-10-13': {}, 'мусор': { a: true } } }],
    junk: 5,
  });
  assert.deepEqual(n.custom, [{ id: 'aaaaaaaaaaaa', date: '2026-10-12', slot: 'day', text: 'ok', on: { a: false, b: true }, sent: { a: true, b: false } }]);
  assert.deepEqual(n.recurring[0].sent, { '2026-10-12': { a: false, b: true } });
  assert.deepEqual(n.recurring[0].on, { a: true, b: true });
  assert.deepEqual(rem.normShr(null), { custom: [], recurring: [] });
});

/* ---------- расход команд ---------- */
test('команды Redis: GET без связи 3, со связью 6; общее создание 8 (в том числе запись в индекс dueq)', async (t) => {
  AT(t);
  const a = await mkAccount(acc, 'anna');
  __cmdLog(true);
  await get(a);
  assert.equal(__cmdLog().length, 3, __cmdLog().join(' | '));
  const b = await mkAccount(acc, 'boris');
  const { token } = await acc.createPairToken(a);
  await acc.joinPair(token, b);
  __cmdLog(true);
  await get(a);
  const log = __cmdLog();
  assert.equal(log.length, 6, log.join(' | ')); // tg, три на проверку пары, общая запись, личная запись
  assert.equal(log.filter((c) => c.startsWith('HMGET shr:')).length, 1, 'общая запись читается один раз');
  __cmdLog(true);
  await post(custom, a, { date: '2026-10-12', slot: 'day', text: 'x', shared: true });
  const mk = __cmdLog();
  assert.equal(mk.length, 8, 'общее создание (проверка пары 3, общая запись чтение и запись, ZADD dueq, личная запись, tg): ' + mk.join(' | '));
  assert.equal(mk.filter((c) => c === 'ZADD dueq').length, 1, 'индекс понижается один раз: ' + mk.join(' | '));
  assert.equal(mk.filter((c) => c.startsWith('GET pair:')).length, 2, 'пара проверяется один раз: ' + mk.join(' | '));
});

/* ---------- разрыв связи, удаление, повторное соединение ---------- */
test('разрыв связи удаляет общие напоминания у обоих; личные остаются', async (t) => {
  AT(t);
  const { a, b } = await mkPair();
  await post(custom, a, { date: '2026-10-12', slot: 'day', text: 'общее', shared: true });
  await post(custom, a, { date: '2026-10-12', slot: 'day', text: 'моё личное' });
  assert.ok(__raw(shrKey(a, b)));
  await acc.unpair(b); // разрывает любой из двоих
  assert.ok(!__raw(shrKey(a, b)), 'общая запись удалена');
  assert.equal((await get(a)).body.shared, undefined);
  assert.equal((await get(b)).body.shared, undefined);
  assert.equal((await get(a)).body.custom.length, 1);
  assert.equal((await post(custom, b, { date: '2026-10-12', slot: 'day', text: 'x', shared: true })).statusCode, 409);
  assert.equal((await acc.unpair(a)), null, 'повторный разрыв идемпотентен');
});

test('повторное соединение той же пары не возвращает старые общие напоминания, даже если запись осталась после сбоя', async (t) => {
  AT(t);
  const { a, b } = await mkPair();
  await post(custom, a, { date: '2026-10-12', slot: 'day', text: 'старое', shared: true });
  const saved = __raw(shrKey(a, b));
  await acc.unpair(a);
  const { cmd } = await import('../api/_db.js');
  assert.ok(saved);
  const { token } = await acc.createPairToken(a);
  await cmd('HSET', shrKey(a, b), 'd', saved.d, 'v', saved.v); // «осталась» после разрыва: имитация сбоя перед удалением
  assert.equal((await rem.readShr(a, b)).shr.custom.length, 1, 'запись действительно вернулась');
  assert.equal((await acc.joinPair(token, b)).id, a);
  assert.equal((await get(a)).body.shared.custom.length, 0);
});

test('удаление аккаунта убирает общую запись пары, у партнёра связи нет, его личное цело', async (t) => {
  AT(t);
  const { a, b } = await mkPair();
  await post(custom, b, { date: '2026-10-12', slot: 'day', text: 'общее', shared: true });
  await post(custom, b, { date: '2026-10-12', slot: 'day', text: 'личное Бориса' });
  assert.equal(await acc.deleteAccount(a), true);
  assert.ok(!__raw(shrKey(a, b)), 'общая запись удалена');
  assert.equal((await get(b)).body.shared, undefined);
  assert.equal((await get(b)).body.custom.length, 1);
});

/* ---------- резервная копия ---------- */
test('вид ключа shr известен резервной копии (hash, не временный)', () => {
  assert.equal(backup.KNOWN.get('shr'), 'hash');
  assert.equal(backup.TEMP.has('shr'), false);
});

/* ---------- рассылка cron ---------- */
// cron берёт время суток из часов: эти тесты идут в 14:30 по Москве (дневной слот наступил, вечерний нет).
const tcron = (name, fn) => test(name, (t) => { pinMsk(t, 14, 30); return fn(t); });
const AUTH = { authorization: 'Bearer test-cron-secret' };
const TODAY = () => rem.mskNow().date;
const hex = (() => { let n = 0; return () => (++n).toString(16).padStart(12, '0'); })();
let tid = 5000;
async function run(query = {}) {
  const res = mockRes();
  const req = mockReq({ method: 'GET', headers: AUTH });
  req.query = query;
  await cron(req, res);
  return res;
}
function mockTg(t, onSend) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const m = String(url).match(/api\.telegram\.org\/bot[^/]+\/(\w+)/);
    assert.ok(m, 'неожиданный запрос: ' + url);
    const body = JSON.parse(opts.body);
    calls.push({ method: m[1], body });
    const r = onSend && m[1] === 'sendMessage' ? onSend(body) : null;
    if (r) return new Response(JSON.stringify(r.body), { status: r.status });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  return calls;
}
const sentTo = (calls, chat) => calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === chat).map((c) => c.body.text).sort();
// Пара, у обоих привязан Telegram.
async function tgPair() {
  const a = await linkUser(acc, 'anna', { id: ++tid, username: 'anna' }), b = await linkUser(acc, 'boris', { id: ++tid, username: 'boris' });
  const { token } = await acc.createPairToken(a);
  assert.equal((await acc.joinPair(token, b)).id, a);
  return { a, b, ca: String((await acc.getLink(a)).chat), cb: String((await acc.getLink(b)).chat) };
}
const addShared = (a, b, text, o = {}) => rem.mutateShr(a, b, (s) => { s.custom.push({ id: hex(), date: TODAY(), slot: 'day', text, on: { a: true, b: true }, sent: { a: false, b: false }, ...o }); });
const addSharedRec = (a, b, text) => rem.mutateShr(a, b, (s) => { s.recurring.push({ id: hex(), date: TODAY(), every: 'week', slot: 'day', text, on: { a: true, b: true }, sent: {} }); });

tcron('cron: общее уходит каждому в свой Telegram один раз, повторный запуск не дублирует; личное и общее раздельно', async (t) => {
  const calls = mockTg(t);
  const { a, b, ca, cb } = await tgPair();
  await addShared(a, b, 'общее'); await addSharedRec(a, b, 'общий повтор');
  await rem.mutateRem(a, (r) => { r.custom.push({ id: hex(), date: TODAY(), slot: 'day', text: 'личное Анны', on: true, sent: false }); });
  const r = await run();
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.accounts, r.body.sent, r.body.failed, r.body.left], [2, 5, 0, 0]);
  assert.deepEqual(sentTo(calls, ca), ['🔔 личное Анны', '🔔 общее', '🔔 общий повтор']);
  assert.deepEqual(sentTo(calls, cb), ['🔔 общее', '🔔 общий повтор']);
  const again = await run();
  assert.equal(again.body.sent, 0);
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 5);
});

tcron('cron: галочка партнёра выключена — ему не шлём, себе шлём; слот evening не трогает дневное', async (t) => {
  const calls = mockTg(t);
  const { a, b, ca, cb } = await tgPair();
  await addShared(a, b, 'без Бориса', { on: { [rem.sideOf(a, b)]: true, [rem.sideOf(b, a)]: false } });
  await addShared(a, b, 'вечернее', { slot: 'evening' });
  assert.equal((await run()).body.sent, 1);
  assert.deepEqual(sentTo(calls, ca), ['🔔 без Бориса']);
  assert.deepEqual(sentTo(calls, cb), []);
  assert.equal((await run({ slot: 'evening' })).body.sent, 2);
  assert.deepEqual(sentTo(calls, cb), ['🔔 вечернее']);
});

tcron('cron: у партнёра нет Telegram — ему ничего не помечается и не уходит; привязал позже в тот же день — получит при повторном запуске', async (t) => {
  const calls = mockTg(t);
  const a = await linkUser(acc, 'anna', { id: ++tid, username: 'anna' }), b = await mkAccount(acc, 'boris');
  const { token } = await acc.createPairToken(a);
  await acc.joinPair(token, b);
  await addShared(a, b, 'общее');
  const r = await run();
  assert.deepEqual([r.body.accounts, r.body.sent, r.body.nolink], [2, 1, 1], 'член пары даёт обоих аккаунтов; у Бориса привязки нет');
  const sb = rem.sideOf(b, a);
  assert.equal((await rem.readShr(a, b)).shr.custom[0].sent[sb], false, 'у Бориса отметки нет');
  assert.deepEqual([...(await dueAll()).keys()], [], 'слать больше некому: у Анны ушло, у Бориса нет привязки — член пары убран');
  const { token: lt } = await acc.createLinkToken(b);
  await acc.bindTelegram(lt, { id: ++tid, username: 'boris' }, tid * 100 + 1);
  await reindexAccount(b); // так делает бот сразу после привязки
  await run();
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 2);
});

tcron('cron: сбой отправки одной стороне снимает отметку только у неё, повтор доставляет; блокировка бота отметку оставляет', async (t) => {
  let failFor = null;
  const calls = mockTg(t, (body) => (String(body.chat_id) === failFor ? { status: 500, body: { ok: false, description: 'Internal error' } } : null));
  const { a, b, ca, cb } = await tgPair();
  await addShared(a, b, 'общее');
  failFor = cb;
  let r = await run();
  assert.equal(r.statusCode, 502);
  assert.deepEqual([r.body.sent, r.body.failed], [1, 1]);
  const sa = rem.sideOf(a, b), sb = rem.sideOf(b, a);
  assert.deepEqual((await rem.readShr(a, b)).shr.custom[0].sent, { [sa]: true, [sb]: false });
  failFor = null;
  r = await run();
  assert.deepEqual([r.statusCode, r.body.sent], [200, 1]);
  assert.deepEqual(sentTo(calls, ca), ['🔔 общее']);
  assert.ok(sentTo(calls, cb).length >= 2, 'Борису после сбоя отправили снова (число попыток зависит от повторов в api/_bot.js)');
  // блокировка
  await addShared(a, b, 'второе');
  calls.length = 0;
  const calls2 = mockTg(t, (body) => (String(body.chat_id) === cb ? { status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } } : null));
  r = await run();
  assert.deepEqual([r.statusCode, r.body.blocked, r.body.failed], [200, 1, 0]);
  assert.equal(calls2.length >= 1, true);
  assert.equal((await rem.readShr(a, b)).shr.custom.find((x) => x.text === 'второе').sent[sb], true);
});

tcron('cron: сухой прогон считает общее и ничего не пишет; после разрыва общее не рассылается', async (t) => {
  const calls = mockTg(t);
  const { a, b } = await tgPair();
  await addShared(a, b, 'общее');
  const before = __raw(shrKey(a, b));
  const d = await run({ dry: '1' });
  assert.deepEqual([d.statusCode, d.body.would_send], [200, 2]);
  assert.deepEqual(__raw(shrKey(a, b)), before);
  assert.equal(calls.length, 0);
  await acc.unpair(a);
  const r = await run();
  assert.equal(r.body.sent, 0);
  assert.equal(calls.length, 0);
});

tcron('cron: расход команд — аккаунт без напоминаний и аккаунт без связи не платят за пару ничего', async (t) => {
  mockTg(t);
  const a = await linkUser(acc, 'anna', { id: ++tid, username: 'anna' });
  __cmdLog(true);
  await run({ dry: '1' });
  assert.deepEqual(__cmdLog().filter((c) => /pair:|shr:|rem:/.test(c)), [], 'не в индексе — ни одной команды по аккаунту');
  await rem.mutateRem(a, (r) => { r.custom.push({ id: 'aaaaaaaaaaaa', date: rem.mskNow().date, slot: 'day', text: 'x', on: true, sent: false }); });
  __cmdLog(true);
  await run({ dry: '1' });
  const log = __cmdLog().filter((c) => /pair:|shr:/.test(c));
  assert.deepEqual(log, [], 'у аккаунта только личные напоминания: проверка пары не нужна');
});

test('общие напоминания: слоты сетки принимаются, planShr сверяет слот по часу', async (t) => {
  AT(t);
  const { a } = await mkPair();
  const r = await post(custom, a, { date: '2026-10-12', slot: 'h16', text: 'общее', shared: true });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.shared.custom[0].slot, 'h16');
  assert.equal((await post(custom, a, { date: '2026-10-12', slot: 'h06', text: 'x', shared: true })).body.error, 'bad request');
  const shr = rem.normShr({ custom: [{ id: 'aaaaaaaaaaaa', date: '2026-10-10', slot: 'h14', text: 'x', on: { a: true, b: true }, sent: { a: false, b: false } }, { id: 'bbbbbbbbbbbb', date: '2026-10-10', slot: 'h15', text: 'y', on: { a: true, b: true }, sent: { a: false, b: false } }] });
  assert.deepEqual(rem.planShr(shr, { month: '2026-10', date: '2026-10-10' }, 'day', 'a').map((x) => x.text), ['x']);
});
