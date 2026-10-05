// Этап 3b: обучение бота и исправление категории. Псевдонимы и ожидающие запросы личные (bot:<id аккаунта> в Redis).
// Обработчик api/telegram.js на заглушке Redis и мок-fetch к Telegram.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __fail } from './redis.mjs';
import { mockReq, mockRes, setEnv, fakeClock, seedDocForce, linkUser } from './helpers.mjs';

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

// Одинаковый документ у обоих аккаунтов: различие между ними в этих тестах только в личном состоянии бота. Для кого-то одного: who.
async function seedDoc(custom = ['Моя категория'], who = [A, B]) {
  for (const id of who) {
    await seedDocForce(lib, id, {
      custom,
      months: { [mskNow().month]: [
        { bank: 'otp', items: [{ cat: 'Супермаркеты', pct: '5' }, { cat: 'Все покупки', pct: '1' }] },
        { bank: 'sber', items: [{ cat: 'Супермаркеты', pct: '10' }] },
      ] },
      rev: {},
    });
  }
}
beforeEach(async () => {
  __reset(); setEnv();
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  A = await linkUser(acc, 'ivan', U1); // чат 101
  B = await linkUser(acc, 'olga', U2); // чат 201
  await seedDoc();
});

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
async function send(update) {
  const res = mockRes();
  await handler(mockReq({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': bot.webhookSecret() }, body: update }), res);
  assert.equal(res.statusCode, 200);
  return res;
}
let n = 0;
const msg = (from, text, chat = { id: from.id * 100 + 1, type: 'private' }) => ({ update_id: ++n, message: { message_id: 5, from, chat, text } });
const cb = (from, data, chat = { id: from.id * 100 + 1, type: 'private' }, mid = 77) => ({ update_id: ++n, callback_query: { id: 'q' + n, from, data, message: { chat, message_id: mid } } });
const last = (calls, method) => calls.filter((c) => c.method === method).at(-1);
const btns = (c) => c.body.reply_markup.inline_keyboard.flat();
const press = (kbOwner, text) => btns(kbOwner).find((b) => b.text === text);
const state = async (id = A) => (await bot.readBot(id)).state;
const strip = (calls) => calls.splice(0, calls.length);

// Ответ на неизвестное: сообщение с кнопками. Возвращает вызов sendMessage.
async function askUnknown(calls, who = U1, text = 'Ларёк у дома') {
  strip(calls);
  await send(msg(who, text));
  return last(calls, 'sendMessage');
}

test('неизвестный → кнопки (сначала заполненные в месяце) → «Другая…» → выбор → личный псевдоним → ответ', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  assert.match(m1.body.text, /^Не знаю такой магазин\. Напишите название категории/);
  assert.match(m1.body.text, /Или выберите категорию кнопкой ниже/);
  assert.equal(m1.body.chat_id, 101);
  assert.deepEqual(btns(m1).map((b) => b.text), ['Все покупки', 'Супермаркеты', 'Другая…']);
  for (const b of btns(m1)) assert.ok(Buffer.byteLength(b.callback_data) <= 64);

  // «Другая…»: остальные категории (в том числе своя) и «Назад»; сообщение не пересылается, меняются только кнопки
  strip(calls);
  await send(cb(U1, press(m1, 'Другая…').callback_data));
  const other = last(calls, 'editMessageReplyMarkup');
  const ot = btns(other).map((b) => b.text);
  assert.ok(ot.includes('Моя категория') && ot.includes('Книги') && ot.includes('← Назад'));
  assert.ok(!ot.includes('Супермаркеты') && !ot.includes('Все покупки'));
  assert.equal(other.body.message_id, 77);

  // «Назад» возвращает первый экран
  strip(calls);
  await send(cb(U1, press(other, '← Назад').callback_data));
  assert.deepEqual(btns(last(calls, 'editMessageReplyMarkup')).map((b) => b.text), ['Все покупки', 'Супермаркеты', 'Другая…']);

  // Выбор на втором экране: «Книги»
  strip(calls);
  await send(cb(U1, press(other, 'Книги').callback_data));
  const ed = last(calls, 'editMessageText');
  assert.equal(ed.body.text, 'Ларёк у дома · Книги\nУ вас нет категории книги\nВсе покупки: 1% — ОТП');
  assert.deepEqual(btns(ed).map((b) => b.text), ['Не та категория', 'Сбросить к словарю']);
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery' && c.body.text === 'Запомнил'));
  const st = await state();
  assert.equal(Object.keys(st.alias).length, 1);
  assert.equal(st.alias['ларек у дома'].c, 'Книги');
  assert.equal(st.alias['ларек у дома'].t, 'Ларёк у дома');

  // Тот же человек пишет то же (другой регистр и знаки) и получает ту же категорию
  strip(calls);
  await send(msg(U1, 'ЛАРЁК, у дома!'));
  const z = last(calls, 'sendMessage');
  assert.equal(z.body.chat_id, 101);
  assert.equal(z.body.text, 'Ларёк у дома · Книги\nУ вас нет категории книги\nВсе покупки: 1% — ОТП');
  assert.deepEqual(btns(z).map((b) => b.text), ['Не та категория', 'Сбросить к словарю']);

  // Личный: другой аккаунт того же не знает, и его состояние пустое
  strip(calls);
  await send(msg(U2, 'Ларёк у дома'));
  assert.match(last(calls, 'sendMessage').body.text, /^Не знаю такой магазин/);
  assert.deepEqual((await state(B)).alias, {});
});

test('выбор среди заполненных категорий сразу даёт ответ с процентами', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls, U2, 'Неведомый магазин');
  strip(calls);
  await send(cb(U2, press(m1, 'Супермаркеты').callback_data, { id: 201, type: 'private' }));
  assert.equal(last(calls, 'editMessageText').body.text, 'Неведомый магазин · Супермаркеты\n✅ 10% — Сбер\n5% — ОТП\nВсе покупки: 1% — ОТП');
});

test('пустой месяц: у неизвестного сразу все категории, без «Другая…»', async (t) => {
  await seedDocForce(lib, A, { custom: [], months: {}, rev: {} });
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  const names = btns(m1).map((b) => b.text);
  assert.equal(names.length, lib.CATS.length);
  assert.ok(!names.includes('Другая…'));
});

test('исправление перекрывает словарь: «Не та категория» → выбор → ответ; опечатка у того же человека даёт то же, у другого аккаунта нет', async (t) => {
  const calls = mockTg(t);
  strip(calls);
  await send(msg(U1, 'Пятёрочка'));
  const a1 = last(calls, 'sendMessage');
  assert.equal(a1.body.text, 'Пятёрочка · Супермаркеты\n✅ 10% — Сбер\n5% — ОТП\nВсе покупки: 1% — ОТП');
  assert.deepEqual(btns(a1).map((b) => b.text), ['Не та категория'], 'сброса нет, пока нет исправления');

  strip(calls);
  await send(cb(U1, press(a1, 'Не та категория').callback_data));
  const pick = last(calls, 'editMessageText');
  assert.equal(pick.body.text, 'Какая категория у «Пятёрочка»?');
  const pt = btns(pick).map((b) => b.text);
  assert.deepEqual(pt.slice(0, 3), ['Все покупки', 'Супермаркеты', 'Другая…']);
  assert.equal(pt.at(-1), 'Отмена');

  strip(calls);
  await send(cb(U1, press(pick, 'Все покупки').callback_data));
  const fixed = last(calls, 'editMessageText');
  assert.equal(fixed.body.text, 'Пятёрочка · Все покупки\n1% — ОТП');
  assert.deepEqual(btns(fixed).map((b) => b.text), ['Не та категория', 'Сбросить к словарю']);
  assert.equal((await state()).alias['пятерочка'].c, 'Все покупки');

  strip(calls);
  await send(msg(U1, 'пятерчка'));
  assert.equal(last(calls, 'sendMessage').body.text, 'Пятёрочка · Все покупки\n1% — ОТП', 'тот же человек с опечаткой получает исправление');
  strip(calls);
  await send(msg(U2, 'Пятёрочка'));
  assert.equal(last(calls, 'sendMessage').body.text, 'Пятёрочка · Супермаркеты\n✅ 10% — Сбер\n5% — ОТП\nВсе покупки: 1% — ОТП', 'другой аккаунт исправления не видит');
  strip(calls);
  await send(msg(U1, 'Магнит'));
  assert.match(last(calls, 'sendMessage').body.text, /^Магнит · Супермаркеты\n✅ 10%/, 'другие магазины не затронуты');
});

test('«Отмена» возвращает прежний ответ, исправление не записывается', async (t) => {
  const calls = mockTg(t);
  strip(calls);
  await send(msg(U1, 'Пятёрочка'));
  const a1 = last(calls, 'sendMessage');
  strip(calls);
  await send(cb(U1, press(a1, 'Не та категория').callback_data));
  const pick = last(calls, 'editMessageText');
  strip(calls);
  await send(cb(U1, press(pick, 'Отмена').callback_data));
  const back = last(calls, 'editMessageText');
  assert.equal(back.body.text, a1.body.text);
  assert.deepEqual(btns(back).map((b) => b.text), ['Не та категория']);
  assert.deepEqual((await state()).alias, {});
});

test('«Сбросить к словарю»: исправление магазина убирается, ответ снова по словарю', async (t) => {
  const calls = mockTg(t);
  strip(calls);
  await send(msg(U1, 'Пятёрочка'));
  const a1 = last(calls, 'sendMessage');
  strip(calls); await send(cb(U1, press(a1, 'Не та категория').callback_data));
  const pick = last(calls, 'editMessageText');
  strip(calls); await send(cb(U1, press(pick, 'Все покупки').callback_data));
  const fixed = last(calls, 'editMessageText');
  strip(calls);
  await send(cb(U1, press(fixed, 'Сбросить к словарю').callback_data));
  const back = last(calls, 'editMessageText');
  assert.equal(back.body.text, a1.body.text);
  assert.deepEqual(btns(back).map((b) => b.text), ['Не та категория']);
  assert.deepEqual((await state()).alias, {});
  strip(calls);
  await send(msg(U2, 'Пятёрочка'));
  assert.equal(last(calls, 'sendMessage').body.text, a1.body.text);
});

test('«Сбросить к словарю» у выученного неизвестного: снова «не знаю» и кнопки категорий', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  strip(calls); await send(cb(U1, press(m1, 'Супермаркеты').callback_data));
  const learned = last(calls, 'editMessageText');
  strip(calls);
  await send(cb(U1, press(learned, 'Сбросить к словарю').callback_data));
  const back = last(calls, 'editMessageText');
  assert.match(back.body.text, /^Не знаю такой магазин/);
  assert.deepEqual(btns(back).map((b) => b.text), ['Все покупки', 'Супермаркеты', 'Другая…']);
  assert.deepEqual((await state()).alias, {});
});

test('запрос по категории и «не знаю точно» отвечают без кнопок и ничего не пишут в состояние', async (t) => {
  const calls = mockTg(t);
  const before = JSON.stringify(await state());
  for (const q of ['кафе', 'Все покупки', 'моя категория', 'яндекс']) {
    strip(calls);
    await send(msg(U1, q));
    assert.equal(calls.length, 1, q);
    assert.equal(calls[0].body.reply_markup, undefined, q);
  }
  assert.equal(JSON.stringify(await state()), before);
});

test('не привязанный и группа молчат: сообщение, нажатие кнопки и группа не вызывают Telegram и не меняют состояние', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  const pickData = press(m1, 'Супермаркеты').callback_data, otherData = press(m1, 'Другая…').callback_data;
  const before = JSON.stringify(await state());
  strip(calls);
  await send(msg(STRANGER, 'Ларёк у дома'));
  await send(cb(STRANGER, pickData, { id: 99901, type: 'private' }));
  await send(cb(STRANGER, otherData, { id: 99901, type: 'private' }));
  await send(cb(U1, pickData, { id: -500, type: 'group' }));
  await send(cb(U1, pickData, { id: -501, type: 'supergroup' }));
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(await state()), before);
  assert.deepEqual(Object.keys((await state()).alias), []);
});

test('нажатие с мусорными данными: не ломается и ничего не сохраняет', async (t) => {
  const calls = mockTg(t);
  const before = JSON.stringify(await state());
  for (const d of ['sk|zzzz|1', 'sk|abcdef12|x', 'sk|abcdef12', 'sk', '', 'sf|' + 'a'.repeat(200)]) await send(cb(U1, d));
  assert.ok(calls.every((c) => c.method === 'answerCallbackQuery' || c.method === 'editMessageReplyMarkup'));
  assert.equal(JSON.stringify(await state()), before);
});

test('запрос с неизвестным id: «устарел», кнопки убираются, ничего не сохраняется', async (t) => {
  const calls = mockTg(t);
  await send(cb(U1, 'sk|0123abcd|1'));
  const a = last(calls, 'answerCallbackQuery');
  assert.match(a.body.text, /^Запрос устарел/);
  assert.equal(a.body.show_alert, true);
  assert.deepEqual(last(calls, 'editMessageReplyMarkup').body.reply_markup.inline_keyboard, []);
  assert.deepEqual((await state()).alias, {});
});

test('TTL: через сутки кнопки не работают, псевдоним не пишется', async (t) => {
  const clock = fakeClock(t);
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  clock.advance(bot.PENDING_TTL - 60_000);
  strip(calls);
  await send(cb(U1, press(m1, 'Другая…').callback_data));
  assert.equal(last(calls, 'editMessageReplyMarkup').body.reply_markup.inline_keyboard.length > 1, true, 'до истечения суток работает');
  clock.advance(120_000);
  strip(calls);
  await send(cb(U1, press(m1, 'Супермаркеты').callback_data));
  assert.match(last(calls, 'answerCallbackQuery').body.text, /^Запрос устарел/);
  assert.deepEqual((await state()).alias, {});
});

test('категорию убрали с сайта между показом и выбором: понятное сообщение, псевдонима нет', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  strip(calls); await send(cb(U1, press(m1, 'Другая…').callback_data));
  const other = last(calls, 'editMessageReplyMarkup');
  await seedDoc([]); // «Моя категория» удалена
  strip(calls);
  await send(cb(U1, press(other, 'Моя категория').callback_data));
  const a = last(calls, 'answerCallbackQuery');
  assert.match(a.body.text, /^Такой категории уже нет/);
  assert.deepEqual((await state()).alias, {});
});

test('индекс указывает в снимок списка: категории на сайте сдвинулись, а нажатие всё равно относится к показанной кнопке', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  strip(calls); await send(cb(U1, press(m1, 'Другая…').callback_data));
  const other = last(calls, 'editMessageReplyMarkup');
  await seedDoc(['Аааа новая', 'Моя категория']); // список на сайте изменился
  strip(calls);
  await send(cb(U1, press(other, 'Книги').callback_data));
  assert.equal((await state()).alias['ларек у дома'].c, 'Книги');
});

test('лимит ожидающих: после 60 разных запросов в состоянии не больше 50, а свежие кнопки работают', async (t) => {
  const calls = mockTg(t);
  let lastMsg;
  for (let i = 0; i < 60; i++) lastMsg = await askUnknown(calls, U1, 'Неизвестный магазин ' + i + ' qq');
  assert.equal(Object.keys((await state()).pending).length, bot.PENDING_MAX);
  strip(calls);
  await send(cb(U1, press(lastMsg, 'Супермаркеты').callback_data));
  assert.match(last(calls, 'editMessageText').body.text, /^Неизвестный магазин 59 qq · Супермаркеты/);
});

test('повторный вопрос с тем же текстом не плодит ожидающие запросы', async (t) => {
  const calls = mockTg(t);
  for (let i = 0; i < 5; i++) await askUnknown(calls, i % 2 ? U1 : U2, 'Ларёк у дома');
  assert.equal(Object.keys((await state(A)).pending).length, 1);
  assert.equal(Object.keys((await state(B)).pending).length, 1, 'у каждого аккаунта свои ожидающие запросы');
});

test('сбой записи состояния: ответ всё равно приходит, без кнопок', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = mockTg(t);
  __fail('write', 'bot:'); // чтение состояния работает, запись падает
  strip(calls);
  await send(msg(U1, 'Пятёрочка'));
  const a = last(calls, 'sendMessage');
  assert.match(a.body.text, /^Пятёрочка · Супермаркеты/);
  assert.equal(a.body.reply_markup, undefined);
  __fail(null);
});

test('/cashback и /start работают; старые кнопки напоминаний молча «не работают»; состояние не пишется', async (t) => {
  const calls = mockTg(t);
  await send(msg(U1, '/cashback'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /^Кэшбэки, /);
  assert.equal(calls[0].body.reply_markup, undefined);
  strip(calls);
  await send(cb(U1, 'later|halva|2026-10', { id: 101, type: 'private' }, 1));
  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery']);
  strip(calls);
  await send(msg(U1, '/start'));
  assert.match(calls[0].body.text, /^Привет, ivan!/);
  const st = await state();
  assert.deepEqual([st.alias, st.pending], [{}, {}]);
});

test('изоляция: чужая кнопка из сообщения другого аккаунта не работает и не меняет ничего', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls, U1);
  const data = press(m1, 'Супермаркеты').callback_data; // кнопка из чата первого аккаунта
  strip(calls);
  await send(cb(U2, data, { id: 201, type: 'private' }));
  const a = last(calls, 'answerCallbackQuery');
  assert.match(a.body.text, /^Запрос устарел/);
  assert.deepEqual((await state(A)).alias, {});
  assert.deepEqual((await state(B)).alias, {});
  strip(calls);
  await send(cb(U1, data)); // у хозяина та же кнопка работает
  assert.match(last(calls, 'editMessageText').body.text, /^Ларёк у дома · Супермаркеты/);
  assert.equal((await state(A)).alias['ларек у дома'].c, 'Супермаркеты');
  assert.deepEqual((await state(B)).alias, {});
});

test('документ кэшбэков другого аккаунта не участвует: список категорий для кнопок строится по своему', async (t) => {
  await seedDoc(['Только у Ивана'], [A]);
  await seedDoc([], [B]);
  const calls = mockTg(t);
  const m1 = await askUnknown(calls, U1);
  strip(calls); await send(cb(U1, press(m1, 'Другая…').callback_data));
  assert.ok(btns(last(calls, 'editMessageReplyMarkup')).some((b) => b.text === 'Только у Ивана'));
  const m2 = await askUnknown(calls, U2);
  strip(calls); await send(cb(U2, press(m2, 'Другая…').callback_data));
  assert.ok(!btns(last(calls, 'editMessageReplyMarkup')).some((b) => b.text === 'Только у Ивана'));
});
