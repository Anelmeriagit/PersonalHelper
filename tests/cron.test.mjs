// Этап 3b: рассылка api/cron.js по привязанным аккаунтам (tgs → rem:<id> → tg:<id>.chat), лимит скорости, бюджет времени, сбои.
// Заглушка Redis и мок-fetch к Telegram. Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __reset, __keys } from './redis.mjs';
import { mockReq, mockRes, setEnv, linkUser, fakeClock } from './helpers.mjs';

setEnv();
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.CRON_SECRET = 'test-cron-secret';
const acc = await import('../api/_acc.js');
const rem = await import('../api/_rem.js');
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
  assert.deepEqual([r.body.accounts, r.body.sent, r.body.failed, r.body.left], [3, 3, 0, 0]);
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

test('отвязанный аккаунт и аккаунт без записи tg:<id> не получают рассылку и не теряют напоминание', async (t) => {
  const calls = mockTg(t);
  const a = await mkUser('anna'), b = await mkUser('boris');
  await addCustom(a, 'Анна'); await addCustom(b, 'Борис');
  await acc.unlinkTelegram(a);
  const { cmd, key } = await import('../api/_db.js');
  await cmd('DEL', key('tg', b)); // id остался в множестве, записи нет
  const r = await run();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.sent, 0);
  assert.equal(r.body.nolink, 1); // b: в множестве, но привязки нет
  assert.equal(calls.length, 0);
  assert.equal((await rem.readRem(b)).rem.custom[0].sent, false, 'отметка не поставлена: после новой привязки уйдёт');
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
  assert.deepEqual([r.body.dry, r.body.accounts, r.body.would_send], [true, 1, 2], 'без slot считаются оба слота');
  assert.equal((await run({ dry: '1', slot: 'evening' })).body.would_send, 1);
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
