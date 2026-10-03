// Этап 2: обучение бота и исправление категории. Обработчик api/telegram.js на заглушке Blob и мок-fetch к Telegram.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __failPut, put } from './blob.mjs';
import { mockReq, mockRes, setEnv, fakeClock } from './helpers.mjs';

setEnv();
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
const lib = await import('../api/_lib.js');
const bot = await import('../api/_bot.js');
const handler = (await import('../api/telegram.js')).default;

const DENIS = { id: 1, username: 'anelmeria' };
const ZHANNA = { id: 2, username: 'zhannaradeeva' };
const STRANGER = { id: 999, username: 'stranger' };
const PUT = { access: 'private', addRandomSuffix: false, contentType: 'application/json' };

async function seedDoc(custom = ['Моя категория']) {
  await lib.writeDoc(process.env.AUTH_USER, {
    custom,
    months: { [bot.mskNow().month]: {
      zhanna: [{ bank: 'otp', items: [{ cat: 'Супермаркеты', pct: '5' }, { cat: 'Все покупки', pct: '1' }] }],
      denis: [{ bank: 'sber', items: [{ cat: 'Супермаркеты', pct: '10' }] }],
    } },
    rev: {},
  });
}
beforeEach(async () => {
  __reset(); setEnv();
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  const users = { denis: { chat: 101, id: 1, username: 'anelmeria' }, zhanna: { chat: 102, id: 2, username: 'zhannaradeeva' } };
  await put('bot/state.json', JSON.stringify({ users, settings: {}, cycles: {}, custom: [], recurring: [] }), PUT);
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
const state = async () => (await bot.readState()).state;
const strip = (calls) => calls.splice(0, calls.length);

// Ответ на неизвестное: сообщение с кнопками. Возвращает вызов sendMessage.
async function askUnknown(calls, who = DENIS, text = 'Ларёк у дома') {
  strip(calls);
  await send(msg(who, text));
  return last(calls, 'sendMessage');
}

test('неизвестный → кнопки (сначала заполненные в месяце) → «Другая…» → выбор → общий псевдоним → ответ', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  assert.match(m1.body.text, /^Не знаю такой магазин\. Напишите название категории/);
  assert.match(m1.body.text, /Или выберите категорию кнопкой ниже/);
  assert.equal(m1.body.chat_id, 101);
  assert.deepEqual(btns(m1).map((b) => b.text), ['Все покупки', 'Супермаркеты', 'Другая…']);
  for (const b of btns(m1)) assert.ok(Buffer.byteLength(b.callback_data) <= 64);

  // «Другая…»: остальные категории (в том числе своя) и «Назад»; сообщение не пересылается, меняются только кнопки
  strip(calls);
  await send(cb(DENIS, press(m1, 'Другая…').callback_data));
  const other = last(calls, 'editMessageReplyMarkup');
  const ot = btns(other).map((b) => b.text);
  assert.ok(ot.includes('Моя категория') && ot.includes('Книги') && ot.includes('← Назад'));
  assert.ok(!ot.includes('Супермаркеты') && !ot.includes('Все покупки'));
  assert.equal(other.body.message_id, 77);

  // «Назад» возвращает первый экран
  strip(calls);
  await send(cb(DENIS, press(other, '← Назад').callback_data));
  assert.deepEqual(btns(last(calls, 'editMessageReplyMarkup')).map((b) => b.text), ['Все покупки', 'Супермаркеты', 'Другая…']);

  // Выбор на втором экране: «Книги»
  strip(calls);
  await send(cb(DENIS, press(other, 'Книги').callback_data));
  const ed = last(calls, 'editMessageText');
  assert.equal(ed.body.text, 'Ларёк у дома · Книги\nУ вас нет категории книги\nВсе покупки: 1% — Жанна: ОТП');
  assert.deepEqual(btns(ed).map((b) => b.text), ['Не та категория', 'Сбросить к словарю']);
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery' && c.body.text === 'Запомнил для обоих'));
  const st = await state();
  assert.equal(Object.keys(st.alias).length, 1);
  assert.equal(st.alias['ларек у дома'].c, 'Книги');
  assert.equal(st.alias['ларек у дома'].t, 'Ларёк у дома');

  // Общий: Жанна пишет то же (другой регистр и знаки) и получает ту же категорию
  strip(calls);
  await send(msg(ZHANNA, 'ЛАРЁК, у дома!'));
  const z = last(calls, 'sendMessage');
  assert.equal(z.body.chat_id, 201);
  assert.equal(z.body.text, 'Ларёк у дома · Книги\nУ вас нет категории книги\nВсе покупки: 1% — Жанна: ОТП');
  assert.deepEqual(btns(z).map((b) => b.text), ['Не та категория', 'Сбросить к словарю']);
});

test('выбор среди заполненных категорий сразу даёт ответ с процентами', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls, ZHANNA, 'Неведомый магазин');
  strip(calls);
  await send(cb(ZHANNA, press(m1, 'Супермаркеты').callback_data, { id: 201, type: 'private' }));
  assert.equal(last(calls, 'editMessageText').body.text, 'Неведомый магазин · Супермаркеты\n✅ 10% — Денис: Сбер\n5% — Жанна: ОТП\nВсе покупки: 1% — Жанна: ОТП');
});

test('пустой месяц: у неизвестного сразу все категории, без «Другая…»', async (t) => {
  await lib.writeDoc(process.env.AUTH_USER, { custom: [], months: {}, rev: {} });
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  const names = btns(m1).map((b) => b.text);
  assert.equal(names.length, lib.CATS.length);
  assert.ok(!names.includes('Другая…'));
});

test('исправление перекрывает словарь: «Не та категория» → выбор → ответ, а Жанна с опечаткой получает то же', async (t) => {
  const calls = mockTg(t);
  strip(calls);
  await send(msg(DENIS, 'Пятёрочка'));
  const a1 = last(calls, 'sendMessage');
  assert.equal(a1.body.text, 'Пятёрочка · Супермаркеты\n✅ 10% — Денис: Сбер\n5% — Жанна: ОТП\nВсе покупки: 1% — Жанна: ОТП');
  assert.deepEqual(btns(a1).map((b) => b.text), ['Не та категория'], 'сброса нет, пока нет исправления');

  strip(calls);
  await send(cb(DENIS, press(a1, 'Не та категория').callback_data));
  const pick = last(calls, 'editMessageText');
  assert.equal(pick.body.text, 'Какая категория у «Пятёрочка»?');
  const pt = btns(pick).map((b) => b.text);
  assert.deepEqual(pt.slice(0, 3), ['Все покупки', 'Супермаркеты', 'Другая…']);
  assert.equal(pt.at(-1), 'Отмена');

  strip(calls);
  await send(cb(DENIS, press(pick, 'Все покупки').callback_data));
  const fixed = last(calls, 'editMessageText');
  assert.equal(fixed.body.text, 'Пятёрочка · Все покупки\n1% — Жанна: ОТП');
  assert.deepEqual(btns(fixed).map((b) => b.text), ['Не та категория', 'Сбросить к словарю']);
  assert.equal((await state()).alias['пятерочка'].c, 'Все покупки');

  strip(calls);
  await send(msg(ZHANNA, 'пятерчка'));
  assert.equal(last(calls, 'sendMessage').body.text, 'Пятёрочка · Все покупки\n1% — Жанна: ОТП');
  strip(calls);
  await send(msg(DENIS, 'Магнит'));
  assert.match(last(calls, 'sendMessage').body.text, /^Магнит · Супермаркеты\n✅ 10%/, 'другие магазины не затронуты');
});

test('«Отмена» возвращает прежний ответ, исправление не записывается', async (t) => {
  const calls = mockTg(t);
  strip(calls);
  await send(msg(DENIS, 'Пятёрочка'));
  const a1 = last(calls, 'sendMessage');
  strip(calls);
  await send(cb(DENIS, press(a1, 'Не та категория').callback_data));
  const pick = last(calls, 'editMessageText');
  strip(calls);
  await send(cb(DENIS, press(pick, 'Отмена').callback_data));
  const back = last(calls, 'editMessageText');
  assert.equal(back.body.text, a1.body.text);
  assert.deepEqual(btns(back).map((b) => b.text), ['Не та категория']);
  assert.deepEqual((await state()).alias, {});
});

test('«Сбросить к словарю»: исправление магазина убирается, ответ снова по словарю', async (t) => {
  const calls = mockTg(t);
  strip(calls);
  await send(msg(DENIS, 'Пятёрочка'));
  const a1 = last(calls, 'sendMessage');
  strip(calls); await send(cb(DENIS, press(a1, 'Не та категория').callback_data));
  const pick = last(calls, 'editMessageText');
  strip(calls); await send(cb(DENIS, press(pick, 'Все покупки').callback_data));
  const fixed = last(calls, 'editMessageText');
  strip(calls);
  await send(cb(DENIS, press(fixed, 'Сбросить к словарю').callback_data));
  const back = last(calls, 'editMessageText');
  assert.equal(back.body.text, a1.body.text);
  assert.deepEqual(btns(back).map((b) => b.text), ['Не та категория']);
  assert.deepEqual((await state()).alias, {});
  strip(calls);
  await send(msg(ZHANNA, 'Пятёрочка'));
  assert.equal(last(calls, 'sendMessage').body.text, a1.body.text);
});

test('«Сбросить к словарю» у выученного неизвестного: снова «не знаю» и кнопки категорий', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  strip(calls); await send(cb(DENIS, press(m1, 'Супермаркеты').callback_data));
  const learned = last(calls, 'editMessageText');
  strip(calls);
  await send(cb(DENIS, press(learned, 'Сбросить к словарю').callback_data));
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
    await send(msg(DENIS, q));
    assert.equal(calls.length, 1, q);
    assert.equal(calls[0].body.reply_markup, undefined, q);
  }
  assert.equal(JSON.stringify(await state()), before);
});

test('чужой и чужой чат молчат: сообщение, нажатие кнопки и группа не вызывают Telegram и не меняют состояние', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  const pickData = press(m1, 'Супермаркеты').callback_data, otherData = press(m1, 'Другая…').callback_data;
  const before = JSON.stringify(await state());
  strip(calls);
  await send(msg(STRANGER, 'Ларёк у дома'));
  await send(cb(STRANGER, pickData, { id: 99901, type: 'private' }));
  await send(cb(STRANGER, otherData, { id: 99901, type: 'private' }));
  await send(cb(DENIS, pickData, { id: -500, type: 'group' }));
  await send(cb(DENIS, pickData, { id: -501, type: 'supergroup' }));
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(await state()), before);
  assert.deepEqual(Object.keys((await state()).alias), []);
});

test('нажатие с мусорными данными: не ломается и ничего не сохраняет', async (t) => {
  const calls = mockTg(t);
  const before = JSON.stringify(await state());
  for (const d of ['sk|zzzz|1', 'sk|abcdef12|x', 'sk|abcdef12', 'sk', '', 'sf|' + 'a'.repeat(200)]) await send(cb(DENIS, d));
  assert.ok(calls.every((c) => c.method === 'answerCallbackQuery' || c.method === 'editMessageReplyMarkup'));
  assert.equal(JSON.stringify(await state()), before);
});

test('запрос с неизвестным id: «устарел», кнопки убираются, ничего не сохраняется', async (t) => {
  const calls = mockTg(t);
  await send(cb(DENIS, 'sk|0123abcd|1'));
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
  await send(cb(DENIS, press(m1, 'Другая…').callback_data));
  assert.equal(last(calls, 'editMessageReplyMarkup').body.reply_markup.inline_keyboard.length > 1, true, 'до истечения суток работает');
  clock.advance(120_000);
  strip(calls);
  await send(cb(DENIS, press(m1, 'Супермаркеты').callback_data));
  assert.match(last(calls, 'answerCallbackQuery').body.text, /^Запрос устарел/);
  assert.deepEqual((await state()).alias, {});
});

test('категорию убрали с сайта между показом и выбором: понятное сообщение, псевдонима нет', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  strip(calls); await send(cb(DENIS, press(m1, 'Другая…').callback_data));
  const other = last(calls, 'editMessageReplyMarkup');
  await seedDoc([]); // «Моя категория» удалена
  strip(calls);
  await send(cb(DENIS, press(other, 'Моя категория').callback_data));
  const a = last(calls, 'answerCallbackQuery');
  assert.match(a.body.text, /^Такой категории уже нет/);
  assert.deepEqual((await state()).alias, {});
});

test('индекс указывает в снимок списка: категории на сайте сдвинулись, а нажатие всё равно относится к показанной кнопке', async (t) => {
  const calls = mockTg(t);
  const m1 = await askUnknown(calls);
  strip(calls); await send(cb(DENIS, press(m1, 'Другая…').callback_data));
  const other = last(calls, 'editMessageReplyMarkup');
  await seedDoc(['Аааа новая', 'Моя категория']); // список на сайте изменился
  strip(calls);
  await send(cb(DENIS, press(other, 'Книги').callback_data));
  assert.equal((await state()).alias['ларек у дома'].c, 'Книги');
});

test('лимит ожидающих: после 60 разных запросов в состоянии не больше 50, а свежие кнопки работают', async (t) => {
  const calls = mockTg(t);
  let lastMsg;
  for (let i = 0; i < 60; i++) lastMsg = await askUnknown(calls, DENIS, 'Неизвестный магазин ' + i + ' qq');
  assert.equal(Object.keys((await state()).pending).length, bot.PENDING_MAX);
  strip(calls);
  await send(cb(DENIS, press(lastMsg, 'Супермаркеты').callback_data));
  assert.match(last(calls, 'editMessageText').body.text, /^Неизвестный магазин 59 qq · Супермаркеты/);
});

test('повторный вопрос с тем же текстом не плодит ожидающие запросы', async (t) => {
  const calls = mockTg(t);
  for (let i = 0; i < 5; i++) await askUnknown(calls, i % 2 ? DENIS : ZHANNA, 'Ларёк у дома');
  assert.equal(Object.keys((await state()).pending).length, 1);
});

test('сбой записи состояния: ответ всё равно приходит, без кнопок', async (t) => {
  t.mock.method(console, 'error', () => {});
  const calls = mockTg(t);
  __failPut(true); // чтение работает, запись падает
  strip(calls);
  await send(msg(DENIS, 'Пятёрочка'));
  const a = last(calls, 'sendMessage');
  assert.match(a.body.text, /^Пятёрочка · Супермаркеты/);
  assert.equal(a.body.reply_markup, undefined);
  __failPut(false);
});

test('прежнее поведение: /cashback, /start и кнопки напоминаний работают как раньше', async (t) => {
  const calls = mockTg(t);
  await send(msg(DENIS, '/cashback'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /^Кэшбэки, /);
  assert.equal(calls[0].body.reply_markup, undefined);
  strip(calls);
  await send(cb(DENIS, 'later|halva|2026-10', { id: 101, type: 'private' }, 1));
  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery', 'editMessageText']);
  strip(calls);
  await send(msg(DENIS, '/start'));
  assert.match(calls[0].body.text, /^Привет, Денис!/);
  const st = await state();
  assert.deepEqual([st.alias, st.pending], [{}, {}]);
});
