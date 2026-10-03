// Этап 2: псевдонимы и ожидающие запросы (чистые функции) и сохранение новых полей состояния.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, put } from './blob.mjs';
import { setEnv } from './helpers.mjs';

setEnv();
const { CATS } = await import('../api/_lib.js');
const sh = await import('../api/_shops.js');
const bot = await import('../api/_bot.js');
const { resolveShop, shopKey, disp } = sh;

beforeEach(() => { __reset(); setEnv(); });

const NOW = 1_760_000_000_000;
const DOC = { custom: ['Моя категория'], months: { '2026-10': {
  zhanna: [{ bank: 'otp', items: [{ cat: 'Супермаркеты', pct: '5' }, { cat: 'Все покупки', pct: '1' }] }],
  denis: [{ bank: 'sber', items: [{ cat: 'Супермаркеты', pct: '10' }, { cat: 'Моя категория', pct: '3' }] }],
} } };
const A = (c, t = 'X') => ({ c, t, at: NOW });
const allButtons = (kb) => kb.flat();

/* ---------- ключи и название ---------- */
test('shopKey и disp: нормализация, обрезка, заглавная буква', () => {
  assert.equal(shopKey('  Ларёк   «У ДОМА»! '), 'ларек у дома');
  assert.equal(shopKey('!!!'), '');
  assert.equal(shopKey('я'.repeat(500)).length, 60);
  assert.equal(disp('  ларёк   у дома '), 'Ларёк у дома');
  assert.equal(disp(''), '');
  assert.equal(disp('x'.repeat(100)).length, 60);
});

/* ---------- resolveShop ---------- */
test('resolveShop: неизвестный без псевдонима — ключ есть, псевдонима нет', () => {
  const r = resolveShop('Ларёк у дома', DOC.custom, {});
  assert.equal(r.res.kind, 'unknown');
  assert.equal(r.key, 'ларек у дома');
  assert.equal(r.alias, null);
});

test('resolveShop: псевдоним неизвестного даёт категорию и название из записи', () => {
  const r = resolveShop('ЛАРЁК у дома!', DOC.custom, { 'ларек у дома': A('Супермаркеты', 'Ларёк у дома') });
  assert.deepEqual(r.res, { kind: 'found', title: 'Ларёк у дома', cats: ['Супермаркеты'], byCat: false });
  assert.equal(r.key, 'ларек у дома');
  assert.ok(r.alias);
});

test('resolveShop: исправление перекрывает словарь, в том числе для опечатки и латиницы', () => {
  const alias = { [sh.norm('Пятёрочка')]: A('Книги') };
  for (const q of ['Пятёрочка', 'пятерчка', 'pyaterochka', '5ка']) {
    const r = resolveShop(q, DOC.custom, alias);
    assert.deepEqual(r.res, { kind: 'found', title: 'Пятёрочка', cats: ['Книги'], byCat: false }, q);
    assert.equal(r.key, 'пятерочка');
  }
  assert.deepEqual(resolveShop('Магнит', DOC.custom, alias).res.cats, ['Супермаркеты'], 'другие магазины не затронуты');
});

test('resolveShop: исправление на свою категорию с сайта работает, а удалённая категория игнорируется', () => {
  const alias = { пятерочка: A('Моя категория') };
  assert.deepEqual(resolveShop('Пятёрочка', ['Моя категория'], alias).res.cats, ['Моя категория']);
  const r = resolveShop('Пятёрочка', [], alias); // категорию убрали с сайта
  assert.deepEqual(r.res.cats, ['Супермаркеты']);
  assert.ok(r.alias, 'запись видна, чтобы можно было сбросить');
  const u = resolveShop('Ларёк', [], { ларек: A('Моя категория') });
  assert.equal(u.res.kind, 'unknown');
});

test('resolveShop: запрос по категории, «не знаю точно» и пустой запрос не учатся (ключа нет)', () => {
  for (const q of ['кафе', 'Все покупки', 'моя категория', 'яндекс', '', '???']) {
    const r = resolveShop(q, DOC.custom, { кафе: A('Книги') });
    assert.equal(r.key, null, q);
  }
  assert.equal(resolveShop('кафе', DOC.custom, { 'кафе и рестораны': A('Книги') }).res.cats[0], 'Кафе и рестораны', 'категория не переопределяется');
});

test('resolveShop: ключи вроде constructor и __proto__ не ломают поиск', () => {
  for (const q of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = resolveShop(q, [], {});
    assert.equal(r.res.kind, 'unknown', q);
    assert.equal(r.alias, null, q);
  }
});

/* ---------- ожидающие запросы ---------- */
test('pendingPut: id из 8 hex-символов, тот же текст — тот же id, поля extra, null убирает поле', () => {
  const st = { pending: {} };
  const id = bot.pendingPut(st, 'ларёк', NOW, { l: ['A'], f: 1, m: 'fix' });
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(bot.pendingPut(st, 'ларёк', NOW + 5, { m: null }), id);
  assert.deepEqual(st.pending[id], { q: 'ларёк', ts: NOW + 5, l: ['A'], f: 1 });
  assert.notEqual(bot.pendingPut(st, 'другое', NOW, undefined), id);
  assert.equal(Object.keys(st.pending).length, 2);
});

test('pending: живёт 1 сутки, просроченные чистятся при следующей записи', () => {
  const st = { pending: {} };
  const id = bot.pendingPut(st, 'старое', NOW);
  assert.ok(bot.pendingGet(st, id, NOW + bot.PENDING_TTL - 1));
  assert.equal(bot.pendingGet(st, id, NOW + bot.PENDING_TTL + 1), null);
  assert.equal(bot.pendingGet(st, 'нет такого', NOW), null);
  bot.pendingPut(st, 'новое', NOW + bot.PENDING_TTL + 1);
  assert.deepEqual(Object.values(st.pending).map((e) => e.q), ['новое']);
});

test('pending: не больше 50, вытесняются самые старые', () => {
  const st = { pending: {} };
  let first;
  for (let i = 0; i < 60; i++) { const id = bot.pendingPut(st, 'запрос ' + i, NOW + i); if (!i) first = id; }
  assert.equal(Object.keys(st.pending).length, bot.PENDING_MAX);
  assert.equal(bot.PENDING_MAX, 50);
  assert.equal(st.pending[first], undefined);
  assert.ok(Object.values(st.pending).some((e) => e.q === 'запрос 59'));
  assert.ok(!Object.values(st.pending).some((e) => e.q === 'запрос 9'));
});

test('pendingGet: мусор в состоянии не ломает', () => {
  const st = { pending: { a: 5, b: null, c: { q: 1 }, d: { q: 'x' } } };
  for (const k of ['a', 'b', 'c', 'd', 'toString']) assert.equal(bot.pendingGet(st, k, NOW), null);
  bot.pendingPut(st, 'q', NOW);
  assert.deepEqual(Object.values(st.pending).map((e) => e.q), ['q']);
});

/* ---------- псевдонимы ---------- */
test('aliasSet: перезапись по ключу, не больше 200, вытесняются самые старые; aliasDel', () => {
  const st = { alias: {} };
  for (let i = 0; i < 210; i++) bot.aliasSet(st, 'ключ ' + i, 'Книги', 'T', NOW + i);
  assert.equal(Object.keys(st.alias).length, bot.ALIAS_MAX);
  assert.equal(bot.ALIAS_MAX, 200);
  assert.equal(st.alias['ключ 0'], undefined);
  assert.ok(st.alias['ключ 209']);
  bot.aliasSet(st, 'ключ 209', 'Аптеки', 'T2', NOW + 999);
  assert.deepEqual(st.alias['ключ 209'], { c: 'Аптеки', t: 'T2', at: NOW + 999 });
  bot.aliasDel(st, 'ключ 209'); bot.aliasDel(st, 'нет такого');
  assert.equal(st.alias['ключ 209'], undefined);
  assert.equal(Object.keys(st.alias).length, 199);
});

test('aliasSet: числовые ключи (например «5») не нарушают вытеснение по времени', () => {
  const st = { alias: {} };
  bot.aliasSet(st, 'zzz', 'Книги', 'a', NOW);
  bot.aliasSet(st, '5', 'Книги', 'b', NOW + 1);
  for (let i = 0; i < 199; i++) bot.aliasSet(st, 'k' + i, 'Книги', 'c', NOW + 2 + i);
  assert.equal(st.alias.zzz, undefined, 'самый старый — zzz, хотя «5» идёт в объекте первым');
  assert.ok(st.alias['5']);
});

/* ---------- список категорий для кнопок ---------- */
test('catChoices: сначала заполненные в месяце (по алфавиту), затем остальные; свои включены', () => {
  const ch = bot.catChoices(DOC, '2026-10');
  assert.equal(ch.f, 3);
  assert.deepEqual(ch.list.slice(0, 3), ['Все покупки', 'Моя категория', 'Супермаркеты']);
  assert.equal(new Set(ch.list).size, ch.list.length);
  assert.deepEqual([...ch.list].sort(), [...CATS, 'Моя категория'].sort());
  assert.equal(ch.list[3], CATS.find((c) => !ch.list.slice(0, 3).includes(c)), 'остальные в порядке CATS');
});

test('catChoices: пустой месяц — все категории, f = 0; удалённая своя категория не попадает', () => {
  const e = bot.catChoices(DOC, '2026-12');
  assert.equal(e.f, 0);
  assert.equal(e.list.length, CATS.length + 1);
  const gone = bot.catChoices({ custom: [], months: DOC.months }, '2026-10');
  assert.ok(!gone.list.includes('Моя категория'));
  assert.equal(gone.f, 2);
  assert.equal(bot.catChoices({ months: {} }, '2026-10').list.length, CATS.length);
});

/* ---------- кнопки ---------- */
const bytes = (s) => Buffer.byteLength(s);
const ID = 'abcdef12';

test('shopKb: «Не та категория», «Сбросить к словарю» только если есть псевдоним', () => {
  assert.deepEqual(bot.shopKb(ID, false), [[{ text: 'Не та категория', callback_data: 'sf|' + ID }]]);
  assert.deepEqual(bot.shopKb(ID, true), [[{ text: 'Не та категория', callback_data: 'sf|' + ID }], [{ text: 'Сбросить к словарю', callback_data: 'sr|' + ID }]]);
});

test('pickKb: первый экран — заполненные и «Другая…», второй — остальные и «Назад», индексы указывают в общий список', () => {
  const l = ['A', 'B', 'C', 'D', 'E'];
  const first = bot.pickKb(ID, l, 2, false, false);
  assert.deepEqual(first, [[{ text: 'A', callback_data: 'sk|' + ID + '|0' }, { text: 'B', callback_data: 'sk|' + ID + '|1' }], [{ text: 'Другая…', callback_data: 'so|' + ID }]]);
  const other = bot.pickKb(ID, l, 2, true, false);
  assert.deepEqual(other.map((r) => r.map((b) => b.callback_data)), [['sk|' + ID + '|2', 'sk|' + ID + '|3'], ['sk|' + ID + '|4'], ['sp|' + ID]]);
  assert.deepEqual(bot.pickKb(ID, l, 5, false, false).flat().map((b) => b.text), ['A', 'B', 'C', 'D', 'E'], 'все заполнены: «Другой» нет');
  assert.deepEqual(bot.pickKb(ID, l, 0, false, false).flat().map((b) => b.text), l, 'нет заполненных: сразу все, без «Другой»');
  assert.equal(bot.pickKb(ID, l, 2, false, true).flat().at(-1).text, 'Отмена');
  assert.equal(bot.pickKb(ID, l, 2, false, false).flat().some((b) => b.text === 'Отмена'), false);
});

test('callback_data: не длиннее 64 байт и без текста категории, даже для длинных своих названий и 99 категорий', () => {
  const l = Array.from({ length: 99 }, (_, i) => 'Очень длинное название своей категории номер ' + i);
  for (const kb of [bot.pickKb(ID, l, 30, false, true), bot.pickKb(ID, l, 30, true, true), bot.pickKb(ID, l, 0, false, true), bot.shopKb(ID, true)]) {
    for (const b of allButtons(kb)) {
      assert.ok(bytes(b.callback_data) <= 64, b.callback_data);
      assert.match(b.callback_data, /^(sk|so|sp|sf|sr|sb)\|[0-9a-f]{8}(\|\d{1,2})?$/);
    }
  }
  assert.ok(bytes('sk|' + ID + '|999') <= 64);
});

/* ---------- состояние ---------- */
const PUT = { access: 'private', addRandomSuffix: false, contentType: 'application/json' };
test('norm состояния: alias и pending сохраняются при mutate вместе с custom и recurring', async () => {
  const keep = {
    users: { denis: { chat: 1, id: 1, username: 'anelmeria' } }, settings: {}, cycles: {},
    custom: [{ id: 'c1', text: 't' }], recurring: [{ id: 'r1', text: 't' }],
    alias: { ларек: { c: 'Книги', t: 'Ларёк', at: NOW } }, pending: { abcdef12: { q: 'ларёк', ts: NOW } },
  };
  await put('bot/state.json', JSON.stringify(keep), PUT);
  await bot.mutate((st) => { st.settings.x = { on: false }; });
  const { state } = await bot.readState();
  assert.deepEqual(state.alias, keep.alias);
  assert.deepEqual(state.pending, keep.pending);
  assert.deepEqual(state.custom, keep.custom);
  assert.deepEqual(state.recurring, keep.recurring);
  assert.deepEqual(state.settings, { x: { on: false } });
});

test('norm состояния: старый файл без новых полей читается, поля пустые; мусор вместо объектов заменяется', async () => {
  await put('bot/state.json', JSON.stringify({ users: {}, settings: {}, cycles: {}, custom: [], recurring: [] }), PUT);
  let { state } = await bot.readState();
  assert.deepEqual([state.alias, state.pending], [{}, {}]);
  await put('bot/state.json', JSON.stringify({ alias: [1, 2], pending: 'x' }), { ...PUT, allowOverwrite: true });
  ({ state } = await bot.readState());
  assert.deepEqual([state.alias, state.pending], [{}, {}]);
  const empty = (await (async () => { __reset(); return bot.readState(); })()).state;
  assert.deepEqual([empty.alias, empty.pending], [{}, {}]);
});
