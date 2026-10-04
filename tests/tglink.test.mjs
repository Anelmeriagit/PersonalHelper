// Этап 3a: привязка Telegram по ссылке (api/_acc.js, api/tglink.js, /start <токен> в api/telegram.js).
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
// Тест «getMe не отвечает» должен идти первым: имя бота кэшируется в памяти после первого успеха.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset as blobReset, put } from './blob.mjs';
import { __reset, __fail, __keys, __raw, __calls } from './redis.mjs';
import { mockReq, mockRes, setEnv, fakeClock } from './helpers.mjs';

setEnv();
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
const lib = await import('../api/_lib.js');
const acc = await import('../api/_acc.js');
const bot = await import('../api/_bot.js');
const link = (await import('../api/tglink.js')).default;
const hook = (await import('../api/telegram.js')).default;

beforeEach(() => { __reset(); blobReset(); setEnv(); process.env.TELEGRAM_BOT_TOKEN = 'test-token'; });

const mkAcc = async (nick) => (await acc.createAccount(nick, 'pass-12345', 100)).id;
const cookieOf = (id) => ({ cookie: lib.makeCookie(id).split(';')[0] });
async function call(h, method, id, body) {
  const res = mockRes();
  await h(mockReq({ method, headers: id ? cookieOf(id) : {}, body }), res);
  return res;
}
// Мок Telegram: запоминает вызовы; getMe отдаёт имя бота (me=null: Telegram «не отвечает»).
function mockTg(t, me = { username: 'TestBot' }) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const m = String(url).match(/api\.telegram\.org\/bot[^/]+\/(\w+)/);
    assert.ok(m, 'неожиданный запрос: ' + url);
    calls.push({ method: m[1], body: JSON.parse(opts.body) });
    if (m[1] === 'getMe') return me ? new Response(JSON.stringify({ ok: true, result: me })) : new Response(JSON.stringify({ ok: false, description: 'down' }), { status: 500 });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  return calls;
}
async function send(from, text, chat = { id: from.id, type: 'private' }) {
  const res = mockRes();
  await hook(mockReq({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': bot.webhookSecret() }, body: { update_id: 1, message: { message_id: 1, from, chat, text } } }), res);
  return res;
}
const texts = (calls) => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text);
const tokenOf = (url) => url.split('start=')[1];
const U1 = { id: 5551, username: 'Ivan_P' }, U2 = { id: 5552, username: 'olga' };

test('getMe не отвечает → 503, ссылка не выдаётся', async (t) => {
  t.mock.method(console, 'error', () => {});
  mockTg(t, null);
  const id = await mkAcc('ivan');
  const r = await call(link, 'POST', id);
  assert.equal(r.statusCode, 503);
  assert.equal(__keys().filter((k) => k.startsWith('tgt:')).length, 0);
});

test('без сессии 401 на все методы; прочие методы 405', async () => {
  for (const m of ['GET', 'POST', 'DELETE']) assert.equal((await call(link, m, null)).statusCode, 401);
  const id = await mkAcc('ivan');
  assert.equal((await call(link, 'PUT', id)).statusCode, 405);
});

test('POST выдаёт ссылку; в Redis лежит хеш токена, сам токен нигде', async (t) => {
  mockTg(t);
  const id = await mkAcc('ivan');
  const r = await call(link, 'POST', id);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(r.body.url, /^https:\/\/t\.me\/TestBot\?start=[A-Za-z0-9_-]{22}$/);
  assert.equal(r.body.ttl, 600);
  const tok = tokenOf(r.body.url);
  assert.equal(__keys().filter((k) => k.startsWith('tgt:')).length, 1);
  for (const k of __keys()) assert.ok(!k.includes(tok) && !String(__raw(k)).includes(tok), 'токен не должен храниться: ' + k);
  assert.equal((await call(link, 'GET', id)).body.linked, false);
});

test('полный путь: ссылка → /start → привязано; повторное использование токена отвергается', async (t) => {
  const calls = mockTg(t);
  const id = await mkAcc('ivan');
  const tok = tokenOf((await call(link, 'POST', id)).body.url);
  const res = await send(U1, '/start ' + tok);
  assert.equal(res.statusCode, 200);
  assert.equal(texts(calls).pop(), 'Готово: Telegram привязан к аккаунту «ivan».');
  const g = (await call(link, 'GET', id)).body;
  assert.deepEqual(g, { linked: true, username: 'Ivan_P' });
  assert.equal(__raw('tgu:5551'), id);
  assert.equal(JSON.parse(__raw('tg:' + id)).chat, '5551');
  await send(U2, '/start ' + tok);
  assert.match(texts(calls).pop(), /^Ссылка недействительна или устарела/);
  assert.equal(__raw('tgu:5552'), undefined);
});

test('новая ссылка гасит прежнюю', async (t) => {
  const calls = mockTg(t);
  const id = await mkAcc('ivan');
  const a = tokenOf((await call(link, 'POST', id)).body.url);
  const b = tokenOf((await call(link, 'POST', id)).body.url);
  await send(U1, '/start ' + a);
  assert.match(texts(calls).pop(), /недействительна или устарела/);
  await send(U1, '/start ' + b);
  assert.match(texts(calls).pop(), /^Готово/);
});

test('ссылка живёт 10 минут', async (t) => {
  const calls = mockTg(t);
  const clock = fakeClock(t);
  const id = await mkAcc('ivan');
  const tok = tokenOf((await call(link, 'POST', id)).body.url);
  clock.advance(10 * 60 * 1000 + 1000);
  await send(U1, '/start ' + tok);
  assert.match(texts(calls).pop(), /недействительна или устарела/);
  assert.equal((await call(link, 'GET', id)).body.linked, false);
});

test('один Telegram — один аккаунт: чужой аккаунт получает отказ, привязка первого цела', async (t) => {
  const calls = mockTg(t);
  const a = await mkAcc('ivan'), b = await mkAcc('olga');
  await send(U1, '/start ' + tokenOf((await call(link, 'POST', a)).body.url));
  const tokB = tokenOf((await call(link, 'POST', b)).body.url);
  await send(U1, '/start ' + tokB);
  assert.match(texts(calls).pop(), /^Этот Telegram уже привязан к другому аккаунту/);
  assert.equal((await call(link, 'GET', b)).body.linked, false);
  assert.equal((await call(link, 'GET', a)).body.linked, true);
  await send(U1, '/start ' + tokB); // токен уже израсходован
  assert.match(texts(calls).pop(), /недействительна или устарела/);
});

test('аккаунт можно перепривязать к другому Telegram: старый освобождается', async (t) => {
  const calls = mockTg(t);
  const a = await mkAcc('ivan'), b = await mkAcc('olga');
  await send(U1, '/start ' + tokenOf((await call(link, 'POST', a)).body.url));
  await send(U2, '/start ' + tokenOf((await call(link, 'POST', a)).body.url));
  assert.equal((await call(link, 'GET', a)).body.username, 'olga');
  assert.equal(__raw('tgu:5551'), undefined);
  await send(U1, '/start ' + tokenOf((await call(link, 'POST', b)).body.url)); // освободившийся Telegram берёт другой аккаунт
  assert.match(texts(calls).pop(), /^Готово/);
});

test('повторная привязка того же Telegram к тому же аккаунту проходит', async (t) => {
  const calls = mockTg(t);
  const a = await mkAcc('ivan');
  await send(U1, '/start ' + tokenOf((await call(link, 'POST', a)).body.url));
  await send(U1, '/start ' + tokenOf((await call(link, 'POST', a)).body.url));
  assert.match(texts(calls).pop(), /^Готово/);
});

test('DELETE отвязывает, идемпотентен, Telegram освобождается', async (t) => {
  const calls = mockTg(t);
  const a = await mkAcc('ivan'), b = await mkAcc('olga');
  await send(U1, '/start ' + tokenOf((await call(link, 'POST', a)).body.url));
  assert.deepEqual((await call(link, 'DELETE', a)).body, { linked: false });
  assert.deepEqual((await call(link, 'DELETE', a)).body, { linked: false });
  assert.equal((await call(link, 'GET', a)).body.linked, false);
  assert.ok(!__keys().some((k) => k === 'tgu:5551' || k === 'tg:' + a));
  await send(U1, '/start ' + tokenOf((await call(link, 'POST', b)).body.url));
  assert.match(texts(calls).pop(), /^Готово/);
});

test('отвязка не трогает чужую запись обратного поиска', async (t) => {
  mockTg(t);
  const a = await mkAcc('ivan'), b = await mkAcc('olga');
  await send(U1, '/start ' + tokenOf((await call(link, 'POST', a)).body.url));
  await send(U2, '/start ' + tokenOf((await call(link, 'POST', a)).body.url)); // a ушёл на U2
  await send(U1, '/start ' + tokenOf((await call(link, 'POST', b)).body.url)); // U1 теперь у b
  await call(link, 'DELETE', a);
  assert.equal(__raw('tgu:5551'), b);
  assert.equal((await call(link, 'GET', b)).body.linked, true);
});

test('две параллельные попытки с одним токеном: привязывает одна', async (t) => {
  const calls = mockTg(t);
  const a = await mkAcc('ivan');
  const tok = tokenOf((await call(link, 'POST', a)).body.url);
  await Promise.all([send(U1, '/start ' + tok), send(U2, '/start ' + tok)]);
  const out = texts(calls);
  assert.equal(out.filter((x) => /^Готово/.test(x)).length, 1);
  assert.equal(out.filter((x) => /недействительна или устарела/.test(x)).length, 1);
});

test('токен неверного вида: ответ без обращения к Redis', async (t) => {
  const calls = mockTg(t);
  const before = __calls();
  await send(U1, '/start abc');
  await send(U1, '/start ' + 'x'.repeat(40));
  assert.equal(__calls(), before);
  assert.deepEqual(texts(calls).map((x) => x.slice(0, 23)), ['Ссылка недействительна.', 'Ссылка недействительна.']);
});

test('группа: тишина, токен остаётся рабочим', async (t) => {
  const calls = mockTg(t);
  const a = await mkAcc('ivan');
  const tok = tokenOf((await call(link, 'POST', a)).body.url);
  await send(U1, '/start ' + tok, { id: -700, type: 'group' });
  await send(U1, '/start@TestBot ' + tok, { id: -701, type: 'supergroup' });
  assert.equal(texts(calls).length, 0);
  await send(U1, '/start ' + tok);
  assert.match(texts(calls).pop(), /^Готово/);
});

test('/start@бот токен в личном чате тоже работает', async (t) => {
  const calls = mockTg(t);
  const a = await mkAcc('ivan');
  await send(U1, '/start@TestBot ' + tokenOf((await call(link, 'POST', a)).body.url));
  assert.match(texts(calls).pop(), /^Готово/);
});

test('чужой без токена: /start даёт подсказку, остальной текст и команды молчат', async (t) => {
  const calls = mockTg(t);
  await send(U1, '/start');
  assert.equal(texts(calls).length, 1);
  assert.match(texts(calls)[0], /Привязать Telegram/);
  await send(U1, 'Пятёрочка'); await send(U1, '/cashback'); await send(U1, '/starting');
  assert.equal(texts(calls).length, 1);
});

test('Денис без токена: прежнее приветствие и подключение', async (t) => {
  const calls = mockTg(t);
  await put('bot/state.json', JSON.stringify({ users: { denis: { chat: 101, id: 1, username: 'anelmeria' } }, settings: {}, cycles: {}, custom: [], recurring: [] }), { access: 'private', addRandomSuffix: false, contentType: 'application/json' });
  await send({ id: 1, username: 'anelmeria' }, '/start');
  assert.match(texts(calls)[0], /^Привет, Денис!/);
});

test('не более 5 новых ссылок за 10 минут на аккаунт', async (t) => {
  mockTg(t);
  const a = await mkAcc('ivan'), b = await mkAcc('olga');
  for (let i = 0; i < 5; i++) assert.equal((await call(link, 'POST', a)).statusCode, 200);
  assert.equal((await call(link, 'POST', a)).statusCode, 429);
  assert.equal((await call(link, 'POST', b)).statusCode, 200);
});

test('сбой Redis: tglink отвечает 503, бот пишет «что-то пошло не так»', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = mockTg(t);
  const a = await mkAcc('ivan');
  const tok = tokenOf((await call(link, 'POST', a)).body.url);
  __fail('network');
  assert.equal((await call(link, 'GET', a)).statusCode, 503);
  await send(U1, '/start ' + tok);
  assert.match(texts(calls).pop(), /^Что-то пошло не так/);
});

test('токен не попадает в журнал ошибок бота', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...a) => logs.push(a.join(' ')));
  const calls = mockTg(t);
  const a = await mkAcc('ivan');
  const tok = tokenOf((await call(link, 'POST', a)).body.url);
  __fail('network');
  await send(U1, '/start ' + tok);
  assert.ok(calls.length >= 1);
  assert.ok(!logs.join('\n').includes(tok));
});
