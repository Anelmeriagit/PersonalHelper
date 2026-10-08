// Слияние гостевых данных с аккаунтом при входе через Google (гостевой режим, часть 4):
//   правила js/local.js (mergeCb, mergeAg, guestDump, метка guestMerged/guestMark) и обмен с сервером js/merge.js (mergeGuest) на заглушке fetch.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const local = await import('../js/local.js');
const merge = await import('../js/merge.js');
const { clock, shiftM } = await import('../js/time.js');

const CUR = clock().cur, PREV = shiftM(CUR, -1), NEXT = shiftM(CUR, 1), OLD = shiftM(CUR, -6);
const ID = 'a'.repeat(32), ID2 = 'b'.repeat(32);
const blk = (bank, ...items) => ({ bank, items: items.map(([cat, pct]) => ({ cat, pct })) });
const dflt = () => ['app', 'opera', 'mozilla', 'edge'].map((a) => ({ id: a, app: a, h: null, m: null, at: null }));

beforeEach(() => { store.clear(); });

// ---------- кэшбэк ----------
test('mergeCb: аккаунт побеждает, гость заполняет пробелы (месяц, банк)', () => {
  const acc = { months: { [CUR]: [blk('otp', ['АЗС', '5'])] }, custom: [] };
  const gst = { months: { [CUR]: [blk('otp', ['АЗС', '10']), blk('vtb', ['Аптеки', '3'])], [NEXT]: [blk('sber', ['Кино и театры', '7'])] }, custom: [] };
  const r = local.mergeCb(acc, gst);
  assert.deepEqual(r.data.months[CUR], [blk('otp', ['АЗС', '5']), blk('vtb', ['Аптеки', '3'])], 'банк аккаунта не тронут, недостающий добавлен');
  assert.deepEqual(r.data.months[NEXT], [blk('sber', ['Кино и театры', '7'])], 'недостающий месяц скопирован');
  assert.deepEqual(r.parts.sort(), [CUR, NEXT].sort());
});

test('mergeCb: свои категории объединяются, дубли без учёта регистра, блоки с гостевой категорией сохраняются', () => {
  const acc = { months: {}, custom: ['Моя', 'Общая'] };
  const gst = { months: { [CUR]: [blk('otp', ['Гостевая', '5'])] }, custom: ['общая', 'Гостевая'] };
  const r = local.mergeCb(acc, gst);
  assert.deepEqual(r.data.custom, ['Моя', 'Общая', 'Гостевая']);
  assert.deepEqual(r.data.months[CUR], [blk('otp', ['Гостевая', '5'])]);
  assert.deepEqual(r.parts.sort(), ['custom', CUR].sort());
});

test('mergeCb: категория гостя, совпавшая с категорией аккаунта в другом регистре, пишется как у аккаунта', () => {
  const acc = { months: {}, custom: ['Общая'] };
  const gst = { months: { [CUR]: [blk('otp', ['общая', '5'])] }, custom: ['общая'] };
  const r = local.mergeCb(acc, gst);
  assert.deepEqual(r.data.custom, ['Общая']);
  assert.deepEqual(r.data.months[CUR], [blk('otp', ['Общая', '5'])]);
  assert.deepEqual(r.parts, [CUR]);
});

test('mergeCb: не больше 30 своих категорий', () => {
  const acc = { months: {}, custom: Array.from({ length: 28 }, (_, i) => 'А' + i) };
  const gst = { months: {}, custom: ['Б1', 'Б2', 'Б3', 'Б4'] };
  assert.deepEqual(local.mergeCb(acc, gst).data.custom, acc.custom.concat(['Б1', 'Б2']));
});

test('mergeCb: месяц вне окна «прошлый … +2», которого у аккаунта нет, пропускается; у существующего недостающий банк добавляется', () => {
  const gst = { months: { [OLD]: [blk('otp', ['АЗС', '5'])], [PREV]: [blk('vtb', ['АЗС', '5'])] }, custom: [] };
  let r = local.mergeCb({ months: {}, custom: [] }, gst);
  assert.deepEqual(Object.keys(r.data.months), [PREV], 'старый месяц сервер создать не даст');
  r = local.mergeCb({ months: { [OLD]: [blk('sber', ['АЗС', '4'])] }, custom: [] }, gst);
  assert.deepEqual(r.data.months[OLD], [blk('sber', ['АЗС', '4']), blk('otp', ['АЗС', '5'])], 'существующую историю дополнять можно');
});

test('mergeCb: повтор даёт ровно то же (без изменений), ничего не нужно — parts пуст', () => {
  const acc = { months: { [CUR]: [blk('otp', ['АЗС', '5'])] }, custom: ['Моя'] };
  const gst = { months: { [CUR]: [blk('vtb', ['Аптеки', '3'])] }, custom: ['Гость'] };
  const once = local.mergeCb(acc, gst);
  const twice = local.mergeCb(once.data, gst);
  assert.deepEqual(twice.parts, []);
  assert.deepEqual(twice.data, once.data);
  assert.deepEqual(local.mergeCb(acc, { months: {}, custom: [] }).parts, []);
  assert.deepEqual(local.mergeCb(acc, acc).parts, [], 'совпадающие данные — слияние ничего не меняет');
});

test('mergeCb: мусор в данных гостя отбрасывается той же проверкой, что на сервере', () => {
  const gst = { months: { [CUR]: [blk('нет-такого', ['АЗС', '5']), blk('vtb', ['Нет такой', '5'], ['АЗС', '99'], ['АЗС', '5'])] }, custom: ['<b>', 'ок'] };
  const r = local.mergeCb({ months: {}, custom: [] }, gst);
  assert.deepEqual(r.data.custom, ['ок']);
  assert.deepEqual(r.data.months[CUR], [blk('vtb', ['АЗС', '5'])]);
});

// ---------- агент ----------
test('mergeAg: у нового аккаунта (строки по умолчанию) времена гостя подставляются, лишних строк нет', () => {
  const gst = dflt(); gst[0].h = 7; gst[0].m = 20; gst[2].h = 23; gst[2].m = 0;
  const r = local.mergeAg(dflt(), gst);
  assert.equal(r.changed, true);
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.rows.map((x) => [x.app, x.h, x.m]), [['app', 7, 20], ['opera', null, null], ['mozilla', 23, 0], ['edge', null, null]]);
  assert.deepEqual(r.rows.map((x) => x.id), ['app', 'opera', 'mozilla', 'edge'], 'id строк аккаунта сохраняются');
});

test('mergeAg: время аккаунта побеждает; строки гостя без пары добавляются, но не больше 12; повтор ничего не меняет', () => {
  const acc = dflt(); acc[0].h = 9; acc[0].m = 10;
  const gst = [{ id: 'g1', app: 'App', h: 7, m: 20, at: null }, { id: 'g2', app: 'Chrome', h: 5, m: 0, at: null }, { id: 'g3', app: 'app', h: 1, m: 10, at: null }];
  const r = local.mergeAg(acc, gst);
  assert.deepEqual(r.rows.slice(0, 4).map((x) => [x.app, x.h, x.m]), [['app', 9, 10], ['opera', null, null], ['mozilla', null, null], ['edge', null, null]], 'у строки аккаунта время своё');
  assert.deepEqual(r.rows.slice(4).map((x) => [x.app, x.h, x.m]), [['Chrome', 5, 0], ['app', 1, 10]], 'без пары: Chrome и второй «app»');
  assert.equal(new Set(r.rows.map((x) => x.id)).size, r.rows.length, 'id уникальны');
  const again = local.mergeAg(r.rows, gst);
  assert.equal(again.changed, false);
  const many = Array.from({ length: 10 }, (_, i) => ({ id: 'x' + i, app: 'Своя' + i, h: null, m: null, at: null }));
  const lim = local.mergeAg(dflt(), many);
  assert.equal(lim.rows.length, 12);
  assert.deepEqual(lim.rows.slice(4).map((x) => x.app), many.slice(0, 8).map((x) => x.app));
});

test('mergeAg: одинаковые списки не меняются', () => {
  assert.equal(local.mergeAg(dflt(), dflt()).changed, false);
});

// ---------- гостевые данные и метка ----------
test('guestDump: пусто — всё null; с данными — каждая часть отдельно', () => {
  assert.deepEqual(local.guestDump(), { cb: null, ag: null, wf: null });
  localStorage.setItem('g-cb', JSON.stringify({ months: {}, custom: ['Моя'], rev: { custom: 2 } }));
  localStorage.setItem('g-wf', JSON.stringify({ ssid: 'Net', password: 'pass-1234', security: 'WPA', hidden: false }));
  const d = local.guestDump();
  assert.deepEqual(d.cb, { months: {}, custom: ['Моя'] });
  assert.equal(d.ag, null);
  assert.deepEqual(d.wf, { ssid: 'Net', password: 'pass-1234', security: 'WPA', hidden: false });
  localStorage.setItem('g-ag', JSON.stringify({ rows: dflt() }));
  assert.equal(local.guestDump().ag.length, 4);
  localStorage.setItem('g-wf', '{"ssid":"","security":"WPA"}');
  assert.equal(local.guestDump().wf, null, 'негодная сеть не считается');
});

test('метка: ставится по id аккаунта, не больше 20, чужие значения и негодный id отбрасываются', () => {
  assert.equal(local.guestMerged(ID), false);
  assert.equal(local.guestMark('не id'), false);
  assert.equal(local.guestMark(ID), true);
  assert.equal(local.guestMerged(ID), true);
  assert.equal(local.guestMerged(ID2), false, 'другой аккаунт сливается отдельно');
  localStorage.setItem('g-mg', JSON.stringify([ID, 5, 'мусор', { a: 1 }]));
  local.guestMark(ID2);
  assert.deepEqual(JSON.parse(localStorage.getItem('g-mg')), [ID, ID2]);
  for (let i = 0; i < 25; i++) local.guestMark(String(i).padStart(32, '0'));
  const l = JSON.parse(localStorage.getItem('g-mg'));
  assert.equal(l.length, 20);
  assert.equal(l[19], '24'.padStart(32, '0'));
  localStorage.setItem('g-mg', '{битый');
  assert.equal(local.guestMerged(ID), false, 'битая метка = не сливали');
});

// ---------- обмен с сервером ----------
// заглушка сервера: один аккаунт; over[ключ] = статус или 'net' (обрыв связи) для проверки отказов
function server(acct, over = {}) {
  const calls = [];
  globalThis.fetch = async (u, o) => {
    const m = (o && o.method) || 'GET', key = m + ' ' + u, body = o && o.body ? JSON.parse(o.body) : null;
    calls.push({ key, body });
    const ov = over[key];
    if (ov === 'net') throw new TypeError('network');
    const R = (s, j) => new Response(JSON.stringify(j), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (typeof ov === 'number') return R(ov, { error: 'x' });
    if (key === 'PUT /api/data') {
      const rev = {};
      for (const k of Object.keys(body.parts)) {
        if (body.parts[k].base !== (acct.rev[k] || 0)) return R(409, { error: 'conflict' });
        if (k === 'custom') acct.data.custom = body.parts[k].value; else acct.data.months[k] = body.parts[k].value;
        acct.rev[k] = rev[k] = (acct.rev[k] || 0) + 1;
      }
      return R(200, { ok: true, rev });
    }
    if (key === 'GET /api/agent') return R(200, { rows: acct.rows });
    if (key === 'PUT /api/agent') { acct.rows = body.rows; return R(200, { rows: acct.rows }); }
    if (key === 'GET /api/wifi') return R(200, acct.wifi ? { configured: true, ...acct.wifi, qr: { size: 0, rows: [] } } : { configured: false });
    if (key === 'PUT /api/wifi') { acct.wifi = body; return R(200, { configured: true, ...body }); }
    return R(404, { error: 'нет' });
  };
  return calls;
}
const fresh = () => ({ data: { months: { [CUR]: [blk('otp', ['АЗС', '5'])] }, custom: [] }, rev: { [CUR]: 3 }, rows: dflt(), wifi: null });
const jOf = (a) => ({ id: ID, name: '', data: JSON.parse(JSON.stringify(a.data)), rev: { ...a.rev } });
function guestAll() {
  localStorage.setItem('g-cb', JSON.stringify({ months: { [CUR]: [blk('vtb', ['Аптеки', '3'])] }, custom: ['Моя'], rev: {} }));
  const ag = dflt(); ag[1].h = 6; ag[1].m = 30;
  localStorage.setItem('g-ag', JSON.stringify({ rows: ag }));
  localStorage.setItem('g-wf', JSON.stringify({ ssid: 'GuestNet', password: 'guest-pass-1', security: 'WPA', hidden: true }));
}

test('mergeGuest: без id аккаунта, с меткой или без гостевых данных сеть не трогает; пустой гость отмечается', async () => {
  const a = fresh(), calls = server(a);
  guestAll();
  assert.equal(await merge.mergeGuest({ data: a.data, rev: a.rev }), null);
  local.guestMark(ID);
  assert.equal(await merge.mergeGuest(jOf(a)), null);
  store.clear();
  assert.equal(await merge.mergeGuest(jOf(a)), null);
  assert.equal(local.guestMerged(ID), true, 'пустой гость: аккаунт отмечен, чтобы позже не сливать данные, вернувшиеся после выхода');
  assert.equal(calls.length, 0);
});

test('mergeGuest: все три части сливаются, аккаунт получает данные, метка ставится, повторный вход ничего не шлёт', async () => {
  const a = fresh(), calls = server(a);
  guestAll();
  const r = await merge.mergeGuest(jOf(a));
  assert.equal(r.n, 4, 'кэшбэк (месяц и custom), агент, WiFi');
  assert.deepEqual(calls.map((c) => c.key).sort(), ['GET /api/agent', 'GET /api/wifi', 'PUT /api/agent', 'PUT /api/data', 'PUT /api/wifi']);
  const put = calls.find((c) => c.key === 'PUT /api/data').body;
  assert.deepEqual(Object.keys(put.parts).sort(), ['custom', CUR].sort());
  assert.equal(put.parts[CUR].base, 3, 'версия части из ответа аккаунта');
  assert.equal(put.parts.custom.base, 0);
  assert.deepEqual(put.parts[CUR].value, [blk('otp', ['АЗС', '5']), blk('vtb', ['Аптеки', '3'])]);
  assert.deepEqual(r.j.data.months[CUR], put.parts[CUR].value);
  assert.deepEqual(r.j.data.custom, ['Моя']);
  assert.deepEqual(r.j.rev, { [CUR]: 4, custom: 1 }, 'новые версии частей');
  assert.equal(r.j.id, ID);
  assert.deepEqual(a.rows.map((x) => [x.app, x.h, x.m]), [['app', null, null], ['opera', 6, 30], ['mozilla', null, null], ['edge', null, null]]);
  assert.deepEqual(a.wifi, { ssid: 'GuestNet', security: 'WPA', password: 'guest-pass-1', hidden: true });
  assert.equal(local.guestMerged(ID), true);
  calls.length = 0;
  assert.equal(await merge.mergeGuest(jOf(a)), null);
  assert.equal(calls.length, 0, 'второй раз на этот аккаунт слияния нет');
});

test('mergeGuest: сеть WiFi у аккаунта уже есть — не трогается; нет изменений в агенте и кэшбэке — записей нет', async () => {
  const a = fresh(); a.wifi = { ssid: 'Mine', password: 'mine-pass-1', security: 'WPA', hidden: false };
  const calls = server(a);
  localStorage.setItem('g-wf', JSON.stringify({ ssid: 'GuestNet', password: 'guest-pass-1', security: 'WPA', hidden: false }));
  localStorage.setItem('g-ag', JSON.stringify({ rows: dflt() }));
  localStorage.setItem('g-cb', JSON.stringify({ months: { [CUR]: [blk('otp', ['АЗС', '5'])] }, custom: [], rev: {} }));
  assert.equal(await merge.mergeGuest(jOf(a)), null);
  assert.deepEqual(calls.map((c) => c.key).sort(), ['GET /api/agent', 'GET /api/wifi']);
  assert.equal(a.wifi.ssid, 'Mine');
  assert.equal(local.guestMerged(ID), true);
});

test('mergeGuest: отказ записи (5xx, 409, 429, 401, обрыв) — метка не ставится, повтор довершает и не дублирует', async () => {
  for (const bad of [500, 409, 429, 401, 'net']) {
    store.clear();
    const a = fresh(), calls = server(a, { 'PUT /api/data': bad });
    guestAll();
    const r = await merge.mergeGuest(jOf(a));
    assert.equal(local.guestMerged(ID), false, 'отказ ' + bad + ': метки нет');
    assert.equal(r.n, 2, 'агент и WiFi записались');
    assert.equal(r.j, undefined, 'кэшбэк на странице прежний');
    assert.deepEqual(a.data.custom, [], 'кэшбэк на сервере не изменился');
    // повтор: сервер отвечает, кэшбэк записывается, агент и WiFi уже на месте
    server(a);
    const r2 = await merge.mergeGuest(jOf(a));
    assert.equal(local.guestMerged(ID), true);
    assert.equal(r2.n, 2);
    assert.deepEqual(a.data.months[CUR], [blk('otp', ['АЗС', '5']), blk('vtb', ['Аптеки', '3'])]);
    assert.equal(a.rows.length, 4, 'строки агента не задвоились');
    void calls;
  }
});

test('mergeGuest: окончательный отказ сервера (400) повторять не заставляет; обрыв чтения агента — повтор', async () => {
  let a = fresh(); server(a, { 'PUT /api/wifi': 400 });
  guestAll();
  await merge.mergeGuest(jOf(a));
  assert.equal(local.guestMerged(ID), true, '400: данные негодные, повторять бессмысленно');
  store.clear();
  a = fresh(); server(a, { 'GET /api/agent': 'net' });
  guestAll();
  const r = await merge.mergeGuest(jOf(a));
  assert.equal(local.guestMerged(ID), false);
  assert.equal(r.n, 3, 'кэшбэк (две части) и WiFi записались, агент ждёт следующего входа');
});

test('mergeGuest: конфликт версий (аккаунт изменили на другом устройстве) — метка не ставится', async () => {
  const a = fresh(); server(a);
  guestAll();
  const j = jOf(a);
  a.rev[CUR] = 9; // между чтением и записью аккаунт изменился
  await merge.mergeGuest(j);
  assert.equal(local.guestMerged(ID), false);
});
