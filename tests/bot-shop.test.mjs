// Этап 3b: обработчик api/telegram.js. Бот узнаёт человека по привязке Telegram к аккаунту (tgu:<tid>) и отвечает по документу этого аккаунта.
// Заглушка Redis и мок-fetch к Telegram. Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __fail } from './redis.mjs';
import { mockReq, mockRes, setEnv, linkUser } from './helpers.mjs';

setEnv();
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
const lib = await import('../api/_lib.js');
const acc = await import('../api/_acc.js');
const bot = await import('../api/_bot.js');
const { mskNow } = await import('../api/_rem.js');
const handler = (await import('../api/telegram.js')).default;

const U1 = { id: 1, username: 'ivan_p' };
const U2 = { id: 2, username: 'olga' };
const STRANGER = { id: 999, username: 'stranger' };
let A, B; // id аккаунтов U1 и U2

beforeEach(async () => {
  __reset(); setEnv();
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  A = await linkUser(acc, 'ivan', U1); // чат 101
  B = await linkUser(acc, 'olga', U2); // чат 201
  await lib.writeDoc(A, {
    custom: ['Моя категория'],
    months: { [mskNow().month]: [
      { bank: 'otp', items: [{ cat: 'Супермаркеты', pct: '5' }, { cat: 'Все покупки', pct: '1' }] },
      { bank: 'sber', items: [{ cat: 'Супермаркеты', pct: '10' }] },
    ] },
    rev: {},
  });
  // У второго аккаунта другие данные: проверяем, что бот берёт документ того, кто пишет.
  await lib.writeDoc(B, { custom: [], months: { [mskNow().month]: [{ bank: 'alfa', items: [{ cat: 'Супермаркеты', pct: '7' }] }] }, rev: {} });
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

test('текст → ответ по документу своего аккаунта: «Пятёрочка»', async (t) => {
  const calls = mockTg(t);
  const res = await send(msg(U1, 'Пятёрочка'));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.chat_id, 101);
  assert.equal(calls[0].body.text, 'Пятёрочка · Супермаркеты\n✅ 10% — Сбер\n5% — ОТП\nВсе покупки: 1% — ОТП');
});

test('второй аккаунт: опечатка и латиница работают, а проценты из его документа, не из чужого', async (t) => {
  const calls = mockTg(t);
  await send(msg(U2, 'пятерчка'));
  assert.equal(calls[0].body.chat_id, 201); // отвечаем в чат, откуда пришло сообщение
  assert.equal(texts(calls)[0], 'Пятёрочка · Супермаркеты\n7% — Альфа');
});

test('своя категория с сайта понимается, у другого аккаунта её нет', async (t) => {
  const calls = mockTg(t);
  await send(msg(U1, 'моя категория'));
  assert.equal(texts(calls)[0], 'Моя категория\nУ вас нет категории моя категория\nВсе покупки: 1% — ОТП');
  await send(msg(U2, 'моя категория'));
  assert.match(texts(calls)[1], /^Не знаю такой магазин/);
});

test('неизвестный магазин → подсказка про категорию', async (t) => {
  const calls = mockTg(t);
  await send(msg(U1, 'Какой-то ларёк'));
  assert.match(texts(calls)[0], /^Не знаю такой магазин\. Напишите название категории/);
});

test('неоднозначное название → «не знаю»', async (t) => {
  const calls = mockTg(t);
  await send(msg(U1, 'яндекс'));
  assert.match(texts(calls)[0], /^Не знаю точно: /);
});

test('не привязанный Telegram в личном чате: тишина, Telegram не вызывается', async (t) => {
  const calls = mockTg(t);
  const res = await send(msg(STRANGER, 'Пятёрочка'));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0);
});

test('после отвязки бот перестаёт отвечать, после новой привязки отвечает снова', async (t) => {
  const calls = mockTg(t);
  await acc.unlinkTelegram(A);
  await send(msg(U1, 'Пятёрочка'));
  assert.equal(calls.length, 0);
  const { token } = await acc.createLinkToken(A);
  await acc.bindTelegram(token, U1, 101);
  await send(msg(U1, 'Пятёрочка'));
  assert.equal(texts(calls).length, 1);
});

test('username не даёт доступа: тот же username с другим id — чужой', async (t) => {
  const calls = mockTg(t);
  await send(msg({ id: 4242, username: 'ivan_p' }, 'Пятёрочка'));
  assert.equal(calls.length, 0);
});

test('групповой чат даже от привязанного: тишина', async (t) => {
  const calls = mockTg(t);
  await send(msg(U1, 'Пятёрочка', { id: -500, type: 'group' }));
  await send(msg(U1, 'Пятёрочка', { id: -501, type: 'supergroup' }));
  assert.equal(calls.length, 0);
});

test('другие команды и сообщения без текста: тишина', async (t) => {
  const calls = mockTg(t);
  await send(msg(U1, '/help'));
  await send(msg(U1, '/unknown@bot Пятёрочка'));
  await send(msg(U1, '   '));
  await send({ update_id: 2, message: { message_id: 6, from: U1, chat: { id: 101, type: 'private' }, sticker: {} } });
  assert.equal(calls.length, 0);
});

test('/cashback отвечает один раз по документу своего аккаунта и не проваливается в поиск магазина', async (t) => {
  const calls = mockTg(t);
  await send(msg(U1, '/cashback'));
  await send(msg(U2, '/cashback'));
  const out = texts(calls);
  assert.equal(out.length, 2);
  assert.match(out[0], /^Кэшбэки, /);
  assert.equal(out[0], bot.cashbackTexts((await lib.loadDoc(A)).doc, mskNow().month)[0]);
  assert.equal(out[1], bot.cashbackTexts((await lib.loadDoc(B)).doc, mskNow().month)[0]);
  assert.notEqual(out[0], out[1]);
});

test('/start у привязанного: приветствие по нику; у не привязанного: подсказка', async (t) => {
  const calls = mockTg(t);
  await send(msg(U1, '/start'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /^Привет, ivan! Telegram привязан/);
  await send(msg(STRANGER, '/start'));
  assert.match(texts(calls)[1], /Привязать Telegram/);
});

test('сбой чтения документа кэшбэков → понятное сообщение, а не тишина', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = mockTg(t);
  __fail('network', 'doc:'); // привязка читается, документ нет
  await send(msg(U1, 'Пятёрочка'));
  assert.equal(texts(calls).length, 1);
  assert.match(texts(calls)[0], /^Не удалось загрузить данные/);
});

test('Redis целиком недоступен: бот не знает, кто пишет, и молчит; ответ Telegram всё равно 200', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = mockTg(t);
  __fail('network');
  const res = await send(msg(U1, 'Пятёрочка'));
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 0);
});

test('неверный секрет вебхука → 401, Telegram не вызывается', async (t) => {
  const calls = mockTg(t);
  const res = await send(msg(U1, 'Пятёрочка'), 'wrong');
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test('нажатие от чужого молчит; прежние кнопки напоминаний (их больше нет) отвечают «больше не работает»', async (t) => {
  const calls = mockTg(t);
  await send({ update_id: 3, callback_query: { id: 'q1', from: STRANGER, data: 'ok|halva|2026-10', message: { chat: { id: 7 }, message_id: 1 } } });
  assert.equal(calls.length, 0);
  await send({ update_id: 4, callback_query: { id: 'q2', from: U1, data: 'later|halva|2026-10', message: { chat: { id: 101 }, message_id: 1 } } });
  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery']);
  assert.match(calls[0].body.text, /больше не работает/);
});
