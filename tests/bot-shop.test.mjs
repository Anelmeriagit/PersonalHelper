// Этап 1: обработчик api/telegram.js на заглушке Blob и мок-fetch к Telegram.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, put } from './blob.mjs';
import { __fail } from './redis.mjs';
import { mockReq, mockRes, setEnv } from './helpers.mjs';

setEnv();
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
const lib = await import('../api/_lib.js');
const bot = await import('../api/_bot.js');
const handler = (await import('../api/telegram.js')).default;

const DENIS = { id: 1, username: 'anelmeria' };
const ZHANNA = { id: 2, username: 'zhannaradeeva' };
const STRANGER = { id: 999, username: 'stranger' };

beforeEach(async () => {
  __reset(); setEnv();
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  const users = { denis: { chat: 101, id: 1, username: 'anelmeria' }, zhanna: { chat: 102, id: 2, username: 'zhannaradeeva' } };
  await put('bot/state.json', JSON.stringify({ users, settings: {}, cycles: {}, custom: [], recurring: [] }), { access: 'private', addRandomSuffix: false, contentType: 'application/json' });
  await lib.writeDoc(process.env.AUTH_USER, {
    custom: ['Моя категория'],
    months: { [bot.mskNow().month]: {
      zhanna: [{ bank: 'otp', items: [{ cat: 'Супермаркеты', pct: '5' }, { cat: 'Все покупки', pct: '1' }] }],
      denis: [{ bank: 'sber', items: [{ cat: 'Супермаркеты', pct: '10' }] }],
    } },
    rev: {},
  });
});

// Мок Telegram: запоминает вызовы api.telegram.org, отвечает {ok:true}.
function mockTg(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const m = String(url).match(/api\.telegram\.org\/bot[^/]+\/(\w+)/);
    assert.ok(m, 'неожиданный запрос: ' + url);
    calls.push({ method: m[1], body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  return calls;
}
async function send(update, secret = bot.webhookSecret()) {
  const res = mockRes();
  await handler(mockReq({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: update }), res);
  return res;
}
const msg = (from, text, chat = { id: from.id * 100 + 1, type: 'private' }) => ({ update_id: 1, message: { message_id: 5, from, chat, text } });
const texts = (calls) => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text);

test('текст → ответ: Денис пишет «Пятёрочка»', async (t) => {
  const calls = mockTg(t);
  const res = await send(msg(DENIS, 'Пятёрочка'));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.chat_id, 101);
  assert.equal(calls[0].body.text, 'Пятёрочка · Супермаркеты\n✅ 10% — Денис: Сбер\n5% — Жанна: ОТП\nВсе покупки: 1% — Жанна: ОТП');
});

test('текст → ответ: Жанна, опечатка и латиница работают, словарь общий', async (t) => {
  const calls = mockTg(t);
  await send(msg(ZHANNA, 'пятерчка'));
  assert.equal(calls[0].body.chat_id, 201); // отвечаем в чат, откуда пришло сообщение
  assert.match(texts(calls)[0], /^Пятёрочка · Супермаркеты/);
});

test('своя категория с сайта понимается', async (t) => {
  const calls = mockTg(t);
  await send(msg(DENIS, 'моя категория'));
  assert.equal(texts(calls)[0], 'Моя категория\nУ вас нет категории моя категория\nВсе покупки: 1% — Жанна: ОТП');
});

test('неизвестный магазин → подсказка про категорию', async (t) => {
  const calls = mockTg(t);
  await send(msg(DENIS, 'Какой-то ларёк'));
  assert.match(texts(calls)[0], /^Не знаю такой магазин\. Напишите название категории/);
});

test('неоднозначное название → «не знаю»', async (t) => {
  const calls = mockTg(t);
  await send(msg(DENIS, 'яндекс'));
  assert.match(texts(calls)[0], /^Не знаю точно: /);
});

test('чужой пользователь в личном чате: тишина, Telegram не вызывается', async (t) => {
  const calls = mockTg(t);
  const res = await send(msg(STRANGER, 'Пятёрочка'));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0);
});

test('групповой чат даже от Дениса: тишина', async (t) => {
  const calls = mockTg(t);
  await send(msg(DENIS, 'Пятёрочка', { id: -500, type: 'group' }));
  await send(msg(DENIS, 'Пятёрочка', { id: -501, type: 'supergroup' }));
  assert.equal(calls.length, 0);
});

test('другие команды и сообщения без текста: тишина', async (t) => {
  const calls = mockTg(t);
  await send(msg(DENIS, '/help'));
  await send(msg(DENIS, '/unknown@bot Пятёрочка'));
  await send(msg(DENIS, '   '));
  await send({ update_id: 2, message: { message_id: 6, from: DENIS, chat: { id: 101, type: 'private' }, sticker: {} } });
  assert.equal(calls.length, 0);
});

test('/cashback по-прежнему отвечает один раз и не проваливается в поиск магазина', async (t) => {
  const calls = mockTg(t);
  await send(msg(DENIS, '/cashback'));
  const out = texts(calls);
  assert.equal(out.length, 1);
  assert.match(out[0], /^Кэшбэки, /);
  assert.equal(out[0], bot.cashbackTexts((await lib.loadDoc(process.env.AUTH_USER)).doc, bot.mskNow().month)[0]);
});

test('/start по-прежнему подключает бота и пишет приветствие', async (t) => {
  const calls = mockTg(t);
  await send(msg(DENIS, '/start'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /^Привет, Денис!/);
});

test('сбой чтения данных → понятное сообщение, а не тишина', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = mockTg(t);
  __fail('network'); // документ кэшбэков лежит в Redis: чтение падает, состояние бота (Blob) читается
  await send(msg(DENIS, 'Пятёрочка'));
  assert.equal(texts(calls).length, 1);
  assert.match(texts(calls)[0], /^Не удалось загрузить данные/);
});

test('неверный секрет вебхука → 401, Telegram не вызывается', async (t) => {
  const calls = mockTg(t);
  const res = await send(msg(DENIS, 'Пятёрочка'), 'wrong');
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test('callback от чужого и кнопки напоминаний не ломаются', async (t) => {
  const calls = mockTg(t);
  await send({ update_id: 3, callback_query: { id: 'q1', from: STRANGER, data: 'ok|halva|2026-10', message: { chat: { id: 7 }, message_id: 1 } } });
  assert.equal(calls.length, 0);
  await send({ update_id: 4, callback_query: { id: 'q2', from: DENIS, data: 'later|halva|2026-10', message: { chat: { id: 101 }, message_id: 1 } } });
  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery', 'editMessageText']);
});
