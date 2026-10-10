// Этап 3b: рассылка api/cron.js по привязанным аккаунтам (tgs → rem:<id> → tg:<id>.chat), лимит скорости, бюджет времени, сбои.
// Заглушка Redis и мок-fetch к Telegram. Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test as rawTest, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __reset, __keys, __raw, __cmdLog } from './redis.mjs';
import { mockReq, mockRes, setEnv, linkUser, fakeClock, pinMsk } from './helpers.mjs';

// Каждый тест идёт в 14:30 по Москве (дневной слот наступил, вечерний нет): cron берёт время суток из часов.
const test = (name, fn) => rawTest(name, (t) => { pinMsk(t, 14, 30); return fn(t); });

setEnv();
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.CRON_SECRET = 'test-cron-secret';
const acc = await import('../api/_acc.js');
const rem = await import('../api/_rem.js');
const { dueAll } = await import('../api/_due.js');
const { reindexAccount } = await import('../api/_reindex.js');
const cron = (await import('../api/cron.js')).default;

beforeEach(() => { __reset(); setEnv(); process.env.TELEGRAM_BOT_TOKEN = 'test-token'; process.env.CRON_SECRET = 'test-cron-secret'; });

const TODAY = () => rem.mskNow().date;
const hex = () => crypto.randomBytes(6).toString('hex');
const AUTH = { authorization: 'Bearer test-cron-secret' };
let tidSeq = 1000;
const mkUser = (nick) => linkUser(acc, nick, { id: ++tidSeq, username: nick }); // чат = tid * 100 + 1
const chatOf = async (id) => String((await acc.getLink(id)).chat); // в tg:<id> chat хранится строкой, в Telegram уходит как есть
// Временное напоминание на сегодня (записью, в обход проверок сайта).
const addCustom = (id, text, slot = 'day', date = TODAY()) => rem.mutateRem(id, (r) => { r.custom.push({ id: hex(), date, slot, text, on: true, sent: false }); });
const addRec = (id, text, slot = 'day') => rem.mutateRem(id, (r) => { r.recurring.push({ id: hex(), date: TODAY(), every: 'week', slot, text, on: true, sent: {} }); });

async function run(query = {}, headers = AUTH) {
  const res = mockRes();
  const req = mockReq({ method: 'GET', headers });
  req.query = query;
  await cron(req, res);
  return res;
}
// Мок Telegram. onSend(body) может вернуть { status, body } вместо успеха; calls — все sendMessage с временем.
function mockTg(t, onSend) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const m = String(url).match(/api\.telegram\.org\/bot[^/]+\/(\w+)/);
    assert.ok(m, 'неожиданный запрос: ' + url);
    const body = JSON.parse(opts.body);
    calls.push({ method: m[1], body, at: Date.now() });
    const r = onSend && m[1] === 'sendMessage' ? onSend(body) : null;
    if (r) return new Response(JSON.stringify(r.body), { status: r.status });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  return calls;
}
const sent = (calls) => calls.filter((c) => c.method === 'sendMessage');

test('доступ: без заголовка 401; ?send= и ?date без dry отклоняются и ничего не рассылают', async (t) => {
  const calls = mockTg(t);
  assert.equal((await run({}, {})).statusCode, 401);
  assert.equal((await run({}, { authorization: 'Bearer wrong' })).statusCode, 401);
  const a = await mkUser('anna'); await addCustom(a, 'не должно уйти');
  assert.equal((await run({ send: 'halva' })).statusCode, 400);
  assert.equal((await run({ date: '2026-10-25' })).statusCode, 400);
  assert.equal((await run({ dry: '1', date: '25.10' })).statusCode, 400);
  assert.equal(calls.length, 0);
});

test('нет привязанных аккаунтов: 200, ничего не отправлено', async (t) => {
  const calls = mockTg(t);
  const r = await run();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.accounts, 0);
  assert.equal(calls.length, 0);
});

test('рассылка: каждому в свой чат и только своё, слот «day» не трогает вечернее, повторный запуск не дублирует', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna'), b = await mkUser('boris'), c = await mkUser('clara');
  await addCustom(a, 'день Анны'); await addCustom(a, 'вечер Анны', 'evening'); await addRec(a, 'повтор Анны');
  await addCustom(b, 'день Бориса');
  await addCustom(c, 'вчера', 'day', '2020-01-01'); // не сегодня
  const r = await run();
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.accounts, r.body.sent, r.body.failed, r.body.left], [2, 3, 0, 0], 'accounts — аккаунты из индекса: у Клары только вчерашнее, оно в индекс не попадает');
  const by = (chat) => sent(calls).filter((x) => x.body.chat_id === chat).map((x) => x.body.text).sort();
  assert.deepEqual(by(await chatOf(a)), ['🔔 день Анны', '🔔 повтор Анны']);
  assert.deepEqual(by(await chatOf(b)), ['🔔 день Бориса']);
  assert.deepEqual(by(await chatOf(c)), []);
  // повтор: ничего нового
  const r2 = await run();
  assert.equal(r2.body.sent, 0);
  assert.equal(sent(calls).length, 3);
  // вечерний слот: только вечернее
  const r3 = await run({ slot: 'evening' });
  assert.equal(r3.body.sent, 1);
  assert.equal(sent(calls).at(-1).body.text, '🔔 вечер Анны');
  assert.equal(r3.body.slot, 'evening');
});

test('выключенное и уже отправленное не уходят; отметка «отправлено» сохраняется в rem:<id>', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna');
  await addCustom(a, 'выкл'); await addCustom(a, 'вкл');
  await rem.mutateRem(a, (r) => { r.custom.find((x) => x.text === 'выкл').on = false; });
  await run();
  assert.deepEqual(sent(calls).map((x) => x.body.text), ['🔔 вкл']);
  const { rem: after } = await rem.readRem(a);
  assert.equal(after.custom.find((x) => x.text === 'вкл').sent, true);
  assert.equal(after.custom.find((x) => x.text === 'выкл').sent, false);
});

test('отвязанный аккаунт и аккаунт без записи tg:<id> не получают рассылку и не теряют напоминание; новая привязка возвращает напоминание в индекс', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna'), b = await mkUser('boris');
  await addCustom(a, 'Анна'); await addCustom(b, 'Борис');
  await acc.unlinkTelegram(a);
  const { cmd, key } = await import('../api/_db.js');
  await cmd('DEL', key('tg', b)); // id остался в множестве, записи нет
  const r = await run();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.sent, 0);
  assert.equal(r.body.nolink, 2); // оба в индексе (записаны напоминания), у обоих привязки нет: a отвязан, у b нет tg:<id>
  assert.equal(calls.length, 0);
  assert.equal((await rem.readRem(b)).rem.custom[0].sent, false, 'отметка не поставлена: после новой привязки уйдёт');
  assert.deepEqual([...(await dueAll()).keys()], [], 'без привязки члены из индекса убраны: слать некому');
  assert.equal((await run()).body.accounts, 0, 'повторный запуск аккаунтов не трогает');
  // Новая привязка (в боте после bindTelegram вызывается reindexAccount): напоминание снова в индексе и уходит при ближайшем запуске
  const { token } = await acc.createLinkToken(a);
  assert.ok((await acc.bindTelegram(token, { id: ++tidSeq, username: 'anna2' }, tidSeq * 100 + 1)).id);
  await reindexAccount(a);
  const r2 = await run();
  assert.deepEqual([r2.body.accounts, r2.body.sent], [1, 1]);
  assert.deepEqual(sent(calls).map((x) => x.body.text), ['🔔 Анна']);
});

test('сбой отправки: отметка снимается, ответ 502, повторный запуск доставляет; доставленным дубль не уходит', async (t) => {
  t.mock.method(console, 'error', () => {});
  const a = await mkUser('anna'), b = await mkUser('boris');
  await addCustom(a, 'Анна'); await addCustom(b, 'Борис');
  const badChat = await chatOf(a);
  let broken = true;
  const calls = mockTg(t, (body) => (broken && body.chat_id === badChat ? { status: 400, body: { ok: false, description: 'Bad Request: message is too long' } } : null));
  const r1 = await run();
  assert.equal(r1.statusCode, 502);
  assert.deepEqual([r1.body.sent, r1.body.failed], [1, 1]);
  assert.equal((await rem.readRem(a)).rem.custom[0].sent, false);
  assert.equal((await rem.readRem(b)).rem.custom[0].sent, true);
  broken = false;
  const r2 = await run();
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.body.sent, 1);
  assert.deepEqual(sent(calls).filter((x) => x.body.chat_id === badChat && x.body.text === '🔔 Анна').length, 2, 'у Анны две попытки, вторая дошла');
  assert.equal(sent(calls).filter((x) => x.body.text === '🔔 Борис').length, 1, 'Борису не дублируется');
});

test('человек заблокировал бота: считается blocked, ответ 200, повторов нет', async (t) => {
  t.mock.method(console, 'error', () => {});
  const a = await mkUser('anna');
  await addCustom(a, 'Анна');
  const calls = mockTg(t, () => ({ status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } }));
  const r1 = await run();
  assert.equal(r1.statusCode, 200);
  assert.deepEqual([r1.body.sent, r1.body.failed, r1.body.blocked], [0, 0, 1]);
  await run();
  assert.equal(sent(calls).length, 1, 'вторая попытка не делалась');
});

test('ошибка чтения одного аккаунта не мешает остальным: errors считается, ответ 502', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = mockTg(t);
  const a = await mkUser('anna'), b = await mkUser('boris');
  await addCustom(a, 'Анна'); await addCustom(b, 'Борис');
  const { __fail } = await import('./redis.mjs');
  __fail('network', 'rem:' + a); // у Анны запись напоминаний не читается
  const r = await run();
  __fail(null);
  assert.equal(r.statusCode, 502);
  assert.deepEqual([r.body.sent, r.body.errors], [1, 1]);
  assert.deepEqual(sent(calls).map((x) => x.body.text), ['🔔 Борис']);
  assert.ok(!JSON.stringify(r.body).includes(a), 'id аккаунта в ответ не попадает');
});

test('лимит скорости: 10 отправок растянуты по времени (шаг 50 мс), а не уходят разом', async (t) => {
  const calls = mockTg(t);
  for (let i = 0; i < 10; i++) { const id = await mkUser('user' + i); await addCustom(id, 'привет ' + i); }
  const r = await run();
  assert.equal(r.body.sent, 10);
  const at = sent(calls).map((c) => c.at).sort((x, y) => x - y);
  // Идеально 9 × 50 = 450 мс. Порог с запасом на нагрузку машины: без очереди все отправки укладываются в единицы миллисекунд.
  assert.ok(at.at(-1) - at[0] >= 250, 'разброс ' + (at.at(-1) - at[0]) + ' мс');
});

test('бюджет времени: когда 24 с вышло, остальные аккаунты не берутся (left), повторный запуск их доставляет', async (t) => {
  const clock = fakeClock(t);
  let jump = true;
  const calls = mockTg(t, () => { if (jump) { clock.advance(25_000); jump = false; } return null; });
  for (let i = 0; i < 10; i++) { const id = await mkUser('user' + i); await addCustom(id, 'привет ' + i); }
  const r1 = await run();
  assert.equal(r1.statusCode, 502);
  assert.equal(r1.body.left, 2, 'из 10 аккаунтов 8 взяты в работу сразу, 2 не дождались');
  assert.equal(r1.body.sent, 8);
  const r2 = await run();
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.body.sent, 2);
  assert.equal(new Set(sent(calls).map((c) => c.body.text)).size, 10, 'каждому по одному разу');
  assert.equal(sent(calls).length, 10);
});

test('сухой прогон: считает, но не отправляет и не пишет; в ответе только числа', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna'); await addCustom(a, 'Анна'); await addRec(a, 'повтор', 'evening');
  const before = JSON.stringify((await rem.readRem(a)).rem);
  const keysBefore = __keys().join();
  const r = await run({ dry: '1' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.dry, r.body.accounts, r.body.would_send], [true, 1, 1], 'без slot: то, чей час наступил (14:30: дневное, вечернее ещё нет)');
  assert.equal((await run({ dry: '1', slot: 'evening' })).body.would_send, 1);
  assert.equal((await run({ dry: '1', date: TODAY() })).body.would_send, 2, 'с date без часа считается весь день');
  assert.equal((await run({ dry: '1', date: '2020-01-01' })).body.would_send, 0);
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify((await rem.readRem(a)).rem), before);
  assert.equal(__keys().join(), keysBefore);
  assert.ok(!JSON.stringify(r.body).includes(a));
});

test('заголовки: ответ не кэшируется; без Redis — 500, а не падение', async (t) => {
  t.mock.method(console, 'error', () => {});
  mockTg(t);
  const { __fail } = await import('./redis.mjs');
  const ok = await run();
  assert.equal(ok.headers['cache-control'], 'no-store');
  __fail('network');
  const bad = await run();
  __fail(null);
  assert.equal(bad.statusCode, 500);
});

/* ---------- запуск по текущему времени, role, пульс, замок (этап 5, переход на внешний планировщик, часть 2) ---------- */
const db = await import('../api/_db.js');
const hbKey = () => db.key('cron', 'hb');
const lockKey = () => db.key('cron', 'lock');
const TXT = (calls) => sent(calls).map((x) => x.body.text);

test('по времени: уходит всё, чей час наступил, с догонянием в тот же день; раньше срока и повторно не уходит', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna');
  for (const s of ['h07', 'h14', 'h15', 'h23']) await addCustom(a, s, s);
  await addRec(a, 'повтор h09', 'h09');
  pinMsk(t, 6, 50);
  const r0 = await run();
  assert.deepEqual([r0.body.sent, r0.body.hour, r0.body.date], [0, 6, '2026-10-14'], 'до 07:00 ничего');
  pinMsk(t, 14, 30);
  const r1 = await run();
  assert.deepEqual(TXT(calls).sort(), ['🔔 h07', '🔔 h14', '🔔 повтор h09'], 'догнали утренние');
  assert.equal(r1.body.slot, undefined);
  assert.equal((await run()).body.sent, 0, 'повтор не дублирует');
  pinMsk(t, 15, 5);
  assert.equal((await run()).body.sent, 1);
  assert.equal(TXT(calls).at(-1), '🔔 h15');
  pinMsk(t, 23, 50);
  assert.equal((await run()).body.sent, 1);
  assert.equal(TXT(calls).at(-1), '🔔 h23');
  assert.equal(sent(calls).length, 5);
});

test('по времени: слот HH:30 уходит с 30-й минуты, не раньше; ручной slot различает h14 и h14m30', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna');
  for (const s of ['h14', 'h14m30', 'h15m30']) await addCustom(a, s, s);
  pinMsk(t, 14, 20);
  const r0 = await run();
  assert.deepEqual([r0.body.sent, r0.body.hour], [1, 14]);
  assert.deepEqual(TXT(calls), ['🔔 h14'], 'до 14:30 слот h14m30 не уходит');
  pinMsk(t, 14, 40);
  assert.equal((await run()).body.sent, 1);
  assert.deepEqual(TXT(calls).slice(1), ['🔔 h14m30']);
  const r2 = await run({ slot: 'h15m30' });
  assert.deepEqual([r2.statusCode, r2.body.sent, r2.body.slot], [200, 1, 'h15m30'], 'ручной запуск слота: время суток не смотрим');
  assert.deepEqual(TXT(calls).slice(2), ['🔔 h15m30']);
  for (const bad of ['h14m00', 'h14m15', 'h24m30', 'h06m30', 'h14m3']) assert.equal((await run({ slot: bad })).statusCode, 400, bad);
});

test('по времени: вчерашнее неотправленное не догоняется, завтрашнее не уходит', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna');
  await addCustom(a, 'вчера', 'h07', '2026-10-13'); await addCustom(a, 'завтра', 'h07', '2026-10-15');
  pinMsk(t, 20, 0);
  assert.equal((await run()).body.sent, 0);
  assert.equal(calls.length, 0);
});

test('slot: ручной запуск одного слота ровно этого часа, время суток не смотрим; мусорный slot — 400', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna');
  await addCustom(a, 'в 10', 'h10'); await addCustom(a, 'в 20', 'h20');
  const r = await run({ slot: 'h20' });
  assert.deepEqual([r.statusCode, r.body.sent, r.body.slot], [200, 1, 'h20']);
  assert.deepEqual(TXT(calls), ['🔔 в 20']);
  for (const bad of ['h06', 'h24', 'night', '', 'constructor']) assert.equal((await run({ slot: bad })).statusCode, 400, bad);
  assert.equal(calls.length, 1);
});

test('role: основной ставит пульс, ручной слот и сухой прогон пульс не ставят; неизвестная роль — 400', async (t) => {
  mockTg(t);
  await mkUser('anna');
  assert.equal((await run({ role: 'boss' })).statusCode, 400);
  assert.equal(__keys().some((k) => k.includes('cron:')), false, 'при ошибке параметров ничего не записано');
  await run({ dry: '1' }); await run({ slot: 'h10' });
  assert.equal(__raw(hbKey()), undefined, 'сухой прогон и ручной слот пульса не ставят');
  const r = await run({ role: 'primary' });
  assert.deepEqual([r.statusCode, r.body.role, r.body.took_over, r.body.last], [200, 'primary', false, null]);
  assert.ok(Number(__raw(hbKey())) > 0);
  const r2 = await run();
  assert.match(r2.body.last, /^2026-10-14T11:3\d:/, 'last — когда основной сработал до этого запуска (14:30 МСК = 11:30 UTC)');
});

test('запасной: основной сработал меньше 15 минут назад — пропуск без работы; молчит дольше — берёт рассылку сам (took_over)', async (t) => {
  const calls = mockTg(t);
  const clock = fakeClock(t);
  const a = await mkUser('anna'); await addCustom(a, 'Анна', 'h14');
  await run(); // основной: пульс
  await addCustom(a, 'новое', 'h14');
  clock.advance(14 * 60 * 1000);
  __cmdLog(true);
  const sk = await run({ role: 'backup' });
  assert.deepEqual([sk.statusCode, sk.body.skipped, sk.body.took_over, sk.body.role], [200, 'primary alive', false, 'backup']);
  assert.match(sk.body.last, /^\d{4}-\d\d-\d\dT/);
  assert.equal(sent(calls).length, 1, 'запасной ничего не отправил');
  assert.deepEqual(__cmdLog(), ['GET cron:hb'], 'пропуск стоит одной команды');
  clock.advance(2 * 60 * 1000); // 16 минут тишины
  const tk = await run({ role: 'backup' });
  assert.deepEqual([tk.statusCode, tk.body.took_over, tk.body.sent, tk.body.skipped], [200, true, 1, undefined]);
  assert.deepEqual(TXT(calls), ['🔔 Анна', '🔔 новое']);
  assert.equal((await run({ role: 'backup' })).body.took_over, true, 'запасной не ставит пульс: основной по-прежнему считается молчащим');
});

test('запасной без единого пульса (основной ещё не подключён) берёт рассылку сам; сухой прогон показывает took_over и last, ничего не пишет', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna'); await addCustom(a, 'Анна', 'h14');
  const keys = __keys().join();
  const d = await run({ dry: '1', role: 'backup' });
  assert.deepEqual([d.body.dry, d.body.took_over, d.body.last, d.body.would_send, d.body.hour], [true, true, null, 1, 14]);
  assert.equal(__keys().join(), keys, 'сухой прогон не писал: ни пульса, ни замка');
  const r = await run({ role: 'backup' });
  assert.deepEqual([r.body.took_over, r.body.sent], [true, 1]);
  assert.equal(sent(calls).length, 1);
  await run(); // основной ожил
  const d2 = await run({ dry: '1', role: 'backup' });
  assert.deepEqual([d2.body.skipped, d2.body.took_over, d2.body.dry], ['primary alive', false, true]);
});

test('замок: занято — 200 {busy:true} без работы; после запуска замок снят; просроченный замок не мешает', async (t) => {
  const calls = mockTg(t);
  const clock = fakeClock(t);
  const a = await mkUser('anna'); await addCustom(a, 'Анна', 'h14');
  await db.cmd('SET', lockKey(), 'чужой', 'NX', 'PX', 30000);
  const b = await run();
  assert.deepEqual([b.statusCode, b.body.busy, b.body.sent], [200, true, undefined]);
  assert.equal(calls.length, 0);
  assert.equal(__raw(lockKey()), 'чужой', 'чужой замок не тронут');
  assert.ok(Number(__raw(hbKey())) > 0, 'пульс основного ставится и при занятом замке: он жив');
  assert.equal((await run({ dry: '1' })).statusCode, 200, 'сухой прогон замок не берёт');
  clock.advance(30001); // замок истёк
  const r = await run();
  assert.equal(r.body.sent, 1);
  assert.equal(__raw(lockKey()), undefined, 'замок снят в конце запуска');
  // снятие не трогает замок, который успел взять другой запуск
  const tok = await db.lock(lockKey(), 30000);
  assert.ok(tok);
  assert.equal(await db.lock(lockKey(), 30000), null);
  await db.unlock(lockKey(), 'не тот');
  assert.equal(__raw(lockKey()), tok);
  await db.unlock(lockKey(), tok);
  assert.equal(__raw(lockKey()), undefined);
});

test('замок снимается и при ошибке запуска (502), повторный вызов сразу работает', async (t) => {
  t.mock.method(console, 'error', () => {});
  mockTg(t);
  const a = await mkUser('anna'); await addCustom(a, 'Анна', 'h14');
  const { __fail } = await import('./redis.mjs');
  __fail('network', 'rem:' + a);
  assert.equal((await run()).statusCode, 502);
  __fail(null);
  assert.equal(__raw(lockKey()), undefined);
  assert.equal((await run()).body.sent, 1);
});

test('расход команд: запуск без задач — пульс, замок, чтение индекса dueq, отметка копии и снятие замка (6 команд)', async (t) => {
  mockTg(t);
  __cmdLog(true);
  const r = await run();
  assert.equal(r.statusCode, 200);
  const log = __cmdLog();
  assert.ok(log.length <= 6, log.join(' | '));
  assert.ok(log[0].startsWith('GET cron:hb') && log.includes('EVAL cron:lock') && log.includes('ZRANGEBYSCORE dueq'), log.join(' | '));
  assert.ok(!log.some((c) => /tgs|rem:|pair:|tg:/.test(c)), 'без задач ни одного обращения к аккаунтам: ' + log.join(' | '));
});
