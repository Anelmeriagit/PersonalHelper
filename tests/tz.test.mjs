// Часовые пояса, часть 1: api/_tz.js (nowIn, zonedToMs, dayEndIn, cleanTz), поле tz аккаунта (setTz), действие set-tz и tz в me (api/auth.js),
// совпадение с прежней московской арифметикой (_rem.js: mskNow, slotMs, dayEndMs).
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __raw, __keys } from './redis.mjs';
import { mockReq, mockRes, setEnv } from './helpers.mjs';

setEnv();
const auth = (await import('../api/auth.js')).default;
const acc = await import('../api/_acc.js');
const lib = await import('../api/_lib.js');
const tz = await import('../api/_tz.js');
const rem = await import('../api/_rem.js');

beforeEach(() => { __reset(); setEnv(); });

async function signUp(name) {
  const { id } = await acc.googleAccount('sub-' + name, '', 100);
  return { cookie: lib.makeCookie(id).split(';')[0], id };
}
async function post(cookie, body) {
  const res = mockRes();
  await auth(mockReq({ method: 'POST', headers: cookie ? { cookie, 'x-real-ip': '10.0.0.9' } : { 'x-real-ip': '10.0.0.9' }, body }), res);
  return res;
}
const utc = (s) => Date.parse(s);

/* ---------- nowIn ---------- */
test('nowIn: настенное время в разных поясах (Москва, Берлин, Калькутта, Окленд, Лос-Анджелес)', () => {
  const t = new Date('2026-10-14T20:40:00Z');
  assert.deepEqual(tz.nowIn('Europe/Moscow', t), { month: '2026-10', date: '2026-10-14', hour: 23, minute: 40 });
  assert.deepEqual(tz.nowIn('Europe/Berlin', t), { month: '2026-10', date: '2026-10-14', hour: 22, minute: 40 });
  assert.deepEqual(tz.nowIn('Asia/Kolkata', t), { month: '2026-10', date: '2026-10-15', hour: 2, minute: 10 });
  assert.deepEqual(tz.nowIn('Pacific/Auckland', t), { month: '2026-10', date: '2026-10-15', hour: 9, minute: 40 });
  assert.deepEqual(tz.nowIn('America/Los_Angeles', t), { month: '2026-10', date: '2026-10-14', hour: 13, minute: 40 });
});

test('nowIn: граница месяца и года зависит от пояса; полночь — час 0, не 24', () => {
  const t = new Date('2026-12-31T21:30:00Z');
  assert.deepEqual(tz.nowIn('Europe/Moscow', t), { month: '2027-01', date: '2027-01-01', hour: 0, minute: 30 });
  assert.deepEqual(tz.nowIn('America/New_York', t), { month: '2026-12', date: '2026-12-31', hour: 16, minute: 30 });
});

test('nowIn без аргументов берёт Date.now() (подмена в тестах работает)', (t) => {
  t.mock.method(Date, 'now', () => utc('2026-03-01T00:00:00Z'));
  assert.equal(tz.nowIn('Pacific/Auckland').date, '2026-03-01');
  assert.equal(tz.nowIn('America/Los_Angeles').date, '2026-02-28');
});

/* ---------- zonedToMs / dayEndIn ---------- */
test('zonedToMs: Москва совпадает с прежней формулой слота (UTC+3)', () => {
  for (const slot of ['h07', 'h14', 'h18m30', 'h23m30', 'day', 'evening']) {
    assert.equal(rem.slotMs('2026-10-14', slot), Date.parse('2026-10-14T00:00:00Z') + (rem.SLOT_MIN[slot] - 180) * 60000, slot);
    assert.equal(rem.slotMs('2026-10-14', slot, 'Europe/Moscow'), rem.slotMs('2026-10-14', slot), slot);
  }
  assert.equal(rem.dayEndMs('2026-10-14'), Date.parse('2026-10-14T00:00:00Z') + 21 * 3600000 - 1);
});

test('zonedToMs: целые и дробные смещения, восточнее и западнее Москвы', () => {
  assert.equal(tz.zonedToMs('2026-10-14', 9 * 60, 'Asia/Kolkata'), utc('2026-10-14T03:30:00Z'));
  assert.equal(tz.zonedToMs('2026-10-14', 9 * 60, 'Asia/Kathmandu'), utc('2026-10-14T03:15:00Z'));
  assert.equal(tz.zonedToMs('2026-10-14', 9 * 60, 'Pacific/Auckland'), utc('2026-10-13T20:00:00Z')); // UTC+13
  assert.equal(tz.zonedToMs('2026-10-14', 9 * 60, 'America/Los_Angeles'), utc('2026-10-14T16:00:00Z')); // UTC−7
  assert.equal(tz.zonedToMs('2026-10-14', 9 * 60, 'UTC'), utc('2026-10-14T09:00:00Z'));
});

test('zonedToMs: переход на зимнее и летнее время (Берлин, Нью-Йорк): слот остаётся на своих настенных часах', () => {
  // Берлин: 2026-10-25 в 03:00 часы идут назад (UTC+2 → +1), 2027-03-28 в 02:00 вперёд (+1 → +2)
  assert.equal(tz.zonedToMs('2026-10-24', 9 * 60, 'Europe/Berlin'), utc('2026-10-24T07:00:00Z'));
  assert.equal(tz.zonedToMs('2026-10-25', 9 * 60, 'Europe/Berlin'), utc('2026-10-25T08:00:00Z'));
  assert.equal(tz.zonedToMs('2027-03-27', 9 * 60, 'Europe/Berlin'), utc('2027-03-27T08:00:00Z'));
  assert.equal(tz.zonedToMs('2027-03-28', 9 * 60, 'Europe/Berlin'), utc('2027-03-28T07:00:00Z'));
  // Нью-Йорк: 2026-11-01 часы назад (−4 → −5)
  assert.equal(tz.zonedToMs('2026-10-31', 7 * 60, 'America/New_York'), utc('2026-10-31T11:00:00Z'));
  assert.equal(tz.zonedToMs('2026-11-01', 7 * 60, 'America/New_York'), utc('2026-11-01T12:00:00Z'));
  // обратное преобразование: nowIn в этот момент показывает тот же час и дату
  for (const [d, z] of [['2026-10-25', 'Europe/Berlin'], ['2027-03-28', 'Europe/Berlin'], ['2026-11-01', 'America/New_York']]) {
    for (const mins of [7 * 60, 12 * 60 + 30, 23 * 60 + 30]) {
      const n = tz.nowIn(z, new Date(tz.zonedToMs(d, mins, z)));
      assert.equal(n.date, d); assert.equal(n.hour * 60 + n.minute, mins);
    }
  }
});

test('dayEndIn: последняя миллисекунда суток пояса; через неё nowIn уже даёт следующую дату', () => {
  for (const z of ['Europe/Moscow', 'Europe/Berlin', 'Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kathmandu']) {
    const e = tz.dayEndIn('2026-10-24', z);
    assert.equal(tz.nowIn(z, new Date(e)).date, '2026-10-24', z);
    assert.equal(tz.nowIn(z, new Date(e + 1)).date, '2026-10-25', z);
  }
});

test('slotMs и dayEndMs принимают пояс', () => {
  assert.equal(rem.slotMs('2026-10-14', 'h09', 'Europe/Berlin'), utc('2026-10-14T07:00:00Z'));
  assert.equal(rem.dayEndMs('2026-10-14', 'Europe/Berlin'), utc('2026-10-14T22:00:00Z') - 1);
});

test('mskNow совпадает с nowIn для Москвы', () => {
  const d = new Date('2026-10-14T20:59:59Z');
  assert.deepEqual(rem.mskNow(d), tz.nowIn('Europe/Moscow', d));
  assert.deepEqual(rem.mskNow(d), { month: '2026-10', date: '2026-10-14', hour: 23, minute: 59 });
});

/* ---------- cleanTz / tzOf ---------- */
test('cleanTz: принимает названия IANA (приводит к каноническому виду), отвергает смещения и мусор', () => {
  assert.equal(tz.cleanTz('Europe/Berlin'), 'Europe/Berlin');
  assert.equal(tz.cleanTz('  europe/berlin '), 'Europe/Berlin');
  const ar = tz.cleanTz('America/Argentina/Buenos_Aires'); // три сегмента проходят; ICU может привести к своему каноническому имени, повторная очистка его не меняет
  assert.ok(ar); assert.equal(tz.cleanTz(ar), ar);
  assert.equal(tz.cleanTz('UTC'), 'UTC');
  for (const bad of ['', ' ', 'Berlin', '+03:00', 'UTC+3', 'GMT', 'Europe/Nowhere', 'Europe/', '/Berlin', 'Europe/Berlin/../x', 'A/B/C/D', 'Europe/' + 'x'.repeat(80), null, undefined, 3, {}, []]) {
    assert.equal(tz.cleanTz(bad), null, JSON.stringify(bad));
  }
});

test('tzOf: нет поля или негодное значение — Москва', () => {
  assert.equal(tz.tzOf({ tz: 'Asia/Tokyo' }), 'Asia/Tokyo');
  for (const a of [null, undefined, {}, { tz: '' }, { tz: 'Mars/Base' }, { tz: 5 }]) assert.equal(tz.tzOf(a), 'Europe/Moscow');
});

/* ---------- setTz и действие set-tz ---------- */
test('me без заданного пояса: Москва, tzSet false', async () => {
  const { cookie } = await signUp('anna');
  const r = await post(cookie, { action: 'me' });
  assert.equal(r.body.tz, 'Europe/Moscow'); assert.equal(r.body.tzSet, false);
});

test('set-tz: пояс сохраняется, виден в me, остальные поля аккаунта не теряются', async () => {
  const { cookie, id } = await signUp('anna');
  await post(cookie, { action: 'rename', name: 'Анна' });
  const r = await post(cookie, { action: 'set-tz', tz: 'Europe/Berlin' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { tz: 'Europe/Berlin', tzSet: true });
  const me = await post(cookie, { action: 'me' });
  assert.equal(me.body.tz, 'Europe/Berlin'); assert.equal(me.body.tzSet, true); assert.equal(me.body.name, 'Анна');
  const raw = JSON.parse(__raw('acc:' + id));
  assert.equal(raw.tz, 'Europe/Berlin'); assert.equal(raw.name, 'Анна'); assert.ok(raw.gsub);
});

test('set-tz: явная Москва помечается заданной; пустая строка и null сбрасывают поле', async () => {
  const { cookie, id } = await signUp('anna');
  let r = await post(cookie, { action: 'set-tz', tz: 'Europe/Moscow' });
  assert.deepEqual(r.body, { tz: 'Europe/Moscow', tzSet: true });
  assert.equal(JSON.parse(__raw('acc:' + id)).tz, 'Europe/Moscow');
  for (const reset of ['', '  ', null]) {
    await post(cookie, { action: 'set-tz', tz: 'Asia/Tokyo' });
    r = await post(cookie, { action: 'set-tz', tz: reset });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { tz: 'Europe/Moscow', tzSet: false });
    assert.equal('tz' in JSON.parse(__raw('acc:' + id)), false);
  }
});

test('set-tz: неизвестное название, смещение, не строка — 400, прежний пояс не меняется', async () => {
  const { cookie } = await signUp('anna');
  await post(cookie, { action: 'set-tz', tz: 'Asia/Tokyo' });
  for (const bad of ['Mars/Base', '+03:00', 'Tokyo', 'Europe/' + 'x'.repeat(80)]) {
    const r = await post(cookie, { action: 'set-tz', tz: bad });
    assert.equal(r.statusCode, 400, String(bad));
    assert.deepEqual(r.body, { error: 'Неизвестный часовой пояс' });
  }
  for (const bad of [5, {}, [], true, undefined]) assert.equal((await post(cookie, { action: 'set-tz', tz: bad })).statusCode, 400, JSON.stringify(bad));
  assert.equal((await post(cookie, { action: 'me' })).body.tz, 'Asia/Tokyo');
});

test('set-tz: без сессии 401; id в теле игнорируется; чужой аккаунт не меняется', async () => {
  assert.equal((await post(undefined, { action: 'set-tz', tz: 'Asia/Tokyo' })).statusCode, 401);
  const a = await signUp('anna'), b = await signUp('boris');
  await post(a.cookie, { action: 'set-tz', tz: 'Asia/Tokyo', id: b.id });
  assert.equal((await post(b.cookie, { action: 'me' })).body.tz, 'Europe/Moscow');
  assert.equal((await post(a.cookie, { action: 'me' })).body.tz, 'Asia/Tokyo');
});

test('setTz: аккаунт удалён между чтением и записью — запись не воскресает; нет аккаунта — null', async () => {
  const { id } = await signUp('anna');
  assert.equal(await acc.setTz('0'.repeat(32), 'Asia/Tokyo'), null);
  assert.deepEqual(await acc.setTz(id, 'Mars/Base'), { error: 'bad' });
  await acc.deleteAccount(id);
  assert.equal(await acc.setTz(id, 'Asia/Tokyo'), null);
  assert.equal(__keys().filter((k) => k.startsWith('acc:')).length, 0);
});

test('смена пояса не создаёт новых ключей Redis', async () => {
  const { cookie } = await signUp('anna');
  const before = __keys().slice().sort();
  await post(cookie, { action: 'set-tz', tz: 'Europe/Berlin' });
  assert.deepEqual(__keys().slice().sort(), before);
});
