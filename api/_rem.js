// Личные напоминания аккаунта (этап 3b). Ключ Redis rem:<id аккаунта> (с префиксом DB_PREFIX), запись по версии (CAS) через readRec/writeRec.
//   { custom:    [ { id, date:'YYYY-MM-DD', slot:'h07'|'h07m30' … 'h23'|'h23m30' (или старые 'day'|'evening'), text, on, sent:boolean } ],
//     recurring: [ { id, date:'YYYY-MM-DD' (дата отсчёта), every:'week'|'2weeks'|'month', slot, text, on, sent:{'YYYY-MM-DD':true} } ] }
// Получатель один: Telegram, привязанный к аккаунту (tg:<id>, см. _acc.js). Постоянных напоминаний и поля «кому» больше нет.
// Состояние бота (псевдонимы, ожидающие запросы) лежит отдельно, не здесь: бот пишет его на каждое сообщение, а эту запись читает и пишет cron.
// Расписание (recDue, recNext), mskNow, лимиты и EVERY живут здесь; _bot.js их не знает.
// Общие напоминания соединённой пары (этап 5, «Соединить аккаунты», часть 4): запись shr:<меньший id>:<больший id>, та же форма списков, но у каждого напоминания
// две галочки и две отметки отправки, по одной на аккаунт: on:{a,b}, sent:{a,b} (временные) и sent:{'YYYY-MM-DD':{a,b}} (повторяющиеся).
// a — аккаунт с меньшим id, b — с большим (sideOf). Читать и писать можно только через readShr/mutateShr, а доступ давать только после partnerAcc (target).
import { readRec, writeRec, isPrecond } from './_lib.js';
import { getLink, partnerAcc, pairId } from './_acc.js';
import { dueLower, pairMember } from './_due.js';

export const CUSTOM_MAX = 50; // не больше 50 временных напоминаний
export const RECURRING_MAX = 30; // не больше 30 повторяющихся
export const EVERY = ['week', '2weeks', 'month']; // каждую неделю / каждые 2 недели / каждый месяц

/* ---------- время: Москва ---------- */
// → { month, date, hour, minute }: hour — час по Москве (0–23), minute — минута (0–59). Время берётся через Date.now(), чтобы тесты могли его подменять.
export function mskNow(d = new Date(Date.now())) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => parts.find((x) => x.type === t).value;
  const month = g('year') + '-' + g('month');
  return { month, date: month + '-' + g('day'), hour: parseInt(g('hour'), 10), minute: parseInt(g('minute'), 10) };
}

/* ---------- повторяющиеся: когда срабатывают ---------- */
// С даты отсчёта: каждые 7 / 14 дней или раз в месяц в то же число (если числа в месяце нет, например 31-го, то в последний день месяца).
const daysIn = (cm) => { const [y, m] = cm.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const dayNum = (s) => Math.round(Date.parse(s + 'T00:00:00Z') / 864e5);
export function recDue(it, date) {
  if (!it || typeof it.date !== 'string' || typeof date !== 'string' || date < it.date) return false;
  if (it.every === 'week') return (dayNum(date) - dayNum(it.date)) % 7 === 0;
  if (it.every === '2weeks') return (dayNum(date) - dayNum(it.date)) % 14 === 0;
  if (it.every === 'month') return +date.slice(8, 10) === Math.min(+it.date.slice(8, 10), daysIn(date.slice(0, 7)));
  return false;
}
export function recNext(it, from) {
  for (let i = 0; i < 70; i++) { const d = iso(Date.parse(from + 'T00:00:00Z') + i * 864e5); if (recDue(it, d)) return d; }
  return '';
}

// Слоты «после HH:MM» по Москве: сетка с шагом 30 минут, 07:00…23:30. Ключ: 'h' + две цифры часа для HH:00 ('h07') и 'h' + час + 'm30' для HH:30 ('h07m30').
// Старые 'day' (14:00) и 'evening' (18:00) остаются допустимыми и равны h14 и h18: записи не переписываются. Расписание сравнивает слоты по минутам от полуночи
// (SLOT_MIN: planRem, planShr, slotMs, проверка «late»).
export const FIRST_HOUR = 7, LAST_HOUR = 23;
export const SLOT_MIN = (() => {
  const o = { day: 14 * 60, evening: 18 * 60 };
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) { const k = 'h' + String(h).padStart(2, '0'); o[k] = h * 60; o[k + 'm30'] = h * 60 + 30; }
  return o;
})();
export const MAX_DAYS = 370; // чуть больше года вперёд (на сайте 365)
export const MAX_TEXT = 300;

// Минуты от московской полуночи по результату mskNow() (для проверки «сегодня этот слот уже наступил»: date и минуты из одного замера).
export const minOf = (now) => now.hour * 60 + now.minute;

export function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function cleanText(v) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
export const idOk = (s) => typeof s === 'string' && /^[0-9a-f]{12}$/.test(s);
export const lastDay = (today) => new Date(Date.parse(today + 'T00:00:00Z') + MAX_DAYS * 864e5).toISOString().slice(0, 10);
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/* ---------- запись аккаунта: чтение, нормализация, изменение ---------- */
// Из Redis берём только допустимые записи с допустимыми полями: чужое и испорченное отбрасывается при первой же записи.
function custom1(it) {
  if (!it || !idOk(it.id) || !validDate(it.date) || !own(SLOT_MIN, it.slot) || typeof it.text !== 'string' || !it.text) return null;
  return { id: it.id, date: it.date, slot: it.slot, text: it.text.slice(0, MAX_TEXT), on: it.on !== false, sent: it.sent === true };
}
function rec1(it) {
  if (!it || !idOk(it.id) || !validDate(it.date) || !own(SLOT_MIN, it.slot) || !EVERY.includes(it.every) || typeof it.text !== 'string' || !it.text) return null;
  const sent = {};
  if (it.sent && typeof it.sent === 'object' && !Array.isArray(it.sent)) for (const d of Object.keys(it.sent)) if (validDate(d) && it.sent[d]) sent[d] = true;
  return { id: it.id, date: it.date, every: it.every, slot: it.slot, text: it.text.slice(0, MAX_TEXT), on: it.on !== false, sent };
}
export const normRem = (raw) => ({
  custom: (Array.isArray(raw && raw.custom) ? raw.custom : []).map(custom1).filter(Boolean).slice(0, CUSTOM_MAX),
  recurring: (Array.isArray(raw && raw.recurring) ? raw.recurring : []).map(rec1).filter(Boolean).slice(0, RECURRING_MAX),
});

// → { rem, etag } (нет записи: пустые списки и etag null)
export async function readRem(id) {
  const { raw, etag } = await readRec('rem', id);
  return { rem: normRem(raw), etag };
}

// Читает запись, применяет fn(rem) и пишет по версии. Чужая запись между чтением и записью: повтор со свежими данными (до 6 раз).
// fn меняет rem и возвращает undefined либо { err }; при err ничего не пишется (fn не должна менять rem до проверки).
// После записи индекс dueq понижается до ближайшей отправки (dueTouch); opt.due === false — не трогать индекс (cron уточняет его сам).
// → { rem } или { rem, err }
export async function mutateRem(id, fn, opt) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { rem, etag } = await readRem(id);
    const before = JSON.stringify(rem);
    const r = fn(rem);
    if (r && r.err) return { rem, err: r.err };
    if (JSON.stringify(rem) === before) return { rem };
    try { await writeRec('rem', id, rem, etag); }
    catch (e) { if (!isPrecond(e)) throw e; continue; }
    if (!opt || opt.due !== false) await dueTouch(id, nextDueRem(rem, mskNow()));
    return { rem };
  }
  throw new Error('rem busy');
}

/* ---------- вид для сайта ---------- */
const slotKey = (it) => String(SLOT_MIN[it.slot]).padStart(4, '0'); // для сортировки: минуты слота от полуночи
const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

export const publicCustom = (rem) => rem.custom
  .map((it) => ({ id: it.id, date: it.date, slot: it.slot, text: it.text, on: it.on, sent: it.sent }))
  .sort((a, b) => cmp(a.date + slotKey(a), b.date + slotKey(b)));

// next — ближайшая дата срабатывания (если сегодняшнее уже ушло, то следующая)
export function publicRecurring(rem) {
  const today = mskNow().date, tomorrow = addDays(today, 1);
  return rem.recurring
    .map((it) => ({ id: it.id, date: it.date, every: it.every, slot: it.slot, text: it.text, on: it.on, next: recNext(it, recDue(it, today) && it.sent[today] ? tomorrow : today) }))
    .sort((a, b) => cmp((a.next || '9') + slotKey(a), (b.next || '9') + slotKey(b)));
}

// Ответ всех эндпоинтов напоминаний: { linked, username?, custom, recurring, shared? }. linked — привязан ли Telegram к аккаунту;
// username (без @, может быть пустым) есть только у привязанного и берётся из той же записи tg:<id>, что и linked (одна команда Redis):
// блок «Telegram» на сайте показывает @имя из этого ответа и не делает отдельный GET /api/tglink.
// shared есть только у соединённого аккаунта (нет поля = не соединён): { linked:true, name, custom, recurring }, у каждого напоминания on — своя галочка,
// pon — галочка партнёра. ctx — { pr, shr }, если вызывающий уже проверил пару и прочитал общую запись (иначе читается здесь).
export async function pubRem(id, rem, ctx) {
  const [l, pr] = await Promise.all([getLink(id), ctx ? ctx.pr : partnerAcc(id)]);
  const out = { linked: !!l, ...(l ? { username: l.un || '' } : {}), custom: publicCustom(rem), recurring: publicRecurring(rem) };
  if (pr) {
    const shr = ctx ? ctx.shr : (await readShr(id, pr.id)).shr;
    out.shared = pubShr(sideOf(id, pr.id), pr.acc.name || '', shr);
  }
  return out;
}

/* ---------- индекс dueq: когда ближайшая отправка ---------- */
// Время слота в мс (UTC): Москва без перехода на летнее, UTC+3. Конец московских суток: dayEndMs.
export const slotMs = (date, slot) => Date.parse(date + 'T00:00:00Z') + (SLOT_MIN[slot] - 180) * 60000;
export const dayEndMs = (date) => Date.parse(date + 'T00:00:00Z') + 21 * 3600000 - 1;
// Ближайшая дата повторяющегося, которой ещё нет в отметках: не раньше сегодня и не раньше даты отсчёта; sentToday — сегодняшнее уже ушло.
function recNextDate(it, today, sentToday) {
  const d = recNext(it, it.date > today ? it.date : today);
  return d === today && sentToday ? recNext(it, addDays(today, 1)) : d;
}
// Ближайшее время отправки личных напоминаний (мс) или null. Вчерашнее неотправленное не считается: cron его не догоняет. Прошедший час сегодня считается (догонка).
export function nextDueRem(rem, now) {
  let best = null;
  const upd = (ms) => { if (best === null || ms < best) best = ms; };
  for (const it of rem.custom) if (it.on !== false && !it.sent && it.date >= now.date) upd(slotMs(it.date, it.slot));
  for (const it of rem.recurring) {
    if (it.on === false) continue;
    const d = recNextDate(it, now.date, !!it.sent[now.date]);
    if (d) upd(slotMs(d, it.slot));
  }
  return best;
}
// То же для общих напоминаний пары: учитываются только стороны из sides ('a', 'b').
export function nextDueShr(shr, now, sides) {
  let best = null;
  const upd = (ms) => { if (best === null || ms < best) best = ms; };
  for (const it of shr.custom) if (it.date >= now.date && sides.some((s) => it.on[s] && !it.sent[s])) upd(slotMs(it.date, it.slot));
  for (const it of shr.recurring) {
    for (const s of sides) {
      if (!it.on[s]) continue;
      const d = recNextDate(it, now.date, !!(it.sent[now.date] && it.sent[now.date][s]));
      if (d) upd(slotMs(d, it.slot));
    }
  }
  return best;
}
// Понизить счёт члена индекса. Сбой индекса не отменяет уже записанные данные: суточная перестройка его исправит.
async function dueTouch(member, ms) {
  if (ms === null) return;
  try { await dueLower(member, ms); } catch (e) { console.error('dueq failed', e && (e.kind || e.name), e && e.message); }
}

/* ---------- расписание ---------- */
// Пора ли слать: slot задан (ручной запуск /api/cron?slot=…) — только слот ровно этого времени (h15 не берёт h15m30), время суток не смотрим; slot не задан и в now есть hour —
// всё, чьё время уже наступило (минуты берутся из now.minute, нет — 0; догоняем в тот же день, пометка «отправлено» не даёт дубля); нет ни того ни другого (сухой прогон с date) — весь день.
const slotDue = (it, now, slot) => (slot ? SLOT_MIN[it.slot] === SLOT_MIN[slot] : typeof now.hour !== 'number' || SLOT_MIN[it.slot] <= now.hour * 60 + (now.minute || 0));

// Что отправить сегодня: см. slotDue. Меняет rem: помечает отправки заранее, чтобы повторный запуск cron не дублировал.
// → [{ kind:'custom'|'rec', cid, text, date }]. Вызывать внутри mutateRem и только для аккаунтов с привязанным Telegram.
export function planRem(rem, now, slot) {
  const out = [];
  for (const it of rem.custom) {
    if (it.on === false || it.sent || it.date !== now.date) continue;
    if (!slotDue(it, now, slot)) continue;
    it.sent = true;
    out.push({ kind: 'custom', cid: it.id, text: it.text, date: now.date });
  }
  for (const it of rem.recurring) {
    if (it.on === false || it.sent[now.date] || !recDue(it, now.date)) continue;
    if (!slotDue(it, now, slot)) continue;
    it.sent[now.date] = true;
    out.push({ kind: 'rec', cid: it.id, text: it.text, date: now.date });
  }
  // Чтобы записи не росли: временные старше 60 дней и отметки повторяющихся старше 60 дней удаляются.
  const old = addDays(now.date, -60);
  rem.custom = rem.custom.filter((it) => it.date >= old);
  for (const it of rem.recurring) for (const d of Object.keys(it.sent)) if (d < old) delete it.sent[d];
  return out;
}

// Снимает отметку «отправлено» у неудавшихся отправок (элементы planRem): ручной повтор /api/cron отправит их снова.
export function unclaimRem(rem, fails) {
  for (const f of fails) {
    if (f.kind === 'rec') { const it = rem.recurring.find((x) => x.id === f.cid); if (it) delete it.sent[f.date]; }
    else { const it = rem.custom.find((x) => x.id === f.cid); if (it) it.sent = false; }
  }
}

/* ---------- общие напоминания пары ---------- */
export const sideOf = (id, pid) => (id < pid ? 'a' : 'b'); // a — аккаунт с меньшим id
export const other = (side) => (side === 'a' ? 'b' : 'a');
const two = (v, pick) => ({ a: pick(v && v.a), b: pick(v && v.b) });
const flag = (x) => x !== false; // галочка: нет значения = включено
const done = (x) => x === true; // отправлено: только явное true

function scustom1(it) {
  if (!it || !idOk(it.id) || !validDate(it.date) || !own(SLOT_MIN, it.slot) || typeof it.text !== 'string' || !it.text) return null;
  return { id: it.id, date: it.date, slot: it.slot, text: it.text.slice(0, MAX_TEXT), on: two(it.on, flag), sent: two(it.sent, done) };
}
function srec1(it) {
  if (!it || !idOk(it.id) || !validDate(it.date) || !own(SLOT_MIN, it.slot) || !EVERY.includes(it.every) || typeof it.text !== 'string' || !it.text) return null;
  const sent = {};
  if (it.sent && typeof it.sent === 'object' && !Array.isArray(it.sent)) {
    for (const d of Object.keys(it.sent)) {
      if (!validDate(d)) continue;
      const v = two(it.sent[d], done);
      if (v.a || v.b) sent[d] = v;
    }
  }
  return { id: it.id, date: it.date, every: it.every, slot: it.slot, text: it.text.slice(0, MAX_TEXT), on: two(it.on, flag), sent };
}
// Новое поле общих напоминаний сначала добавить сюда (scustom1/srec1/normShr), иначе оно потеряется при первой же записи.
export const normShr = (raw) => ({
  custom: (Array.isArray(raw && raw.custom) ? raw.custom : []).map(scustom1).filter(Boolean).slice(0, CUSTOM_MAX),
  recurring: (Array.isArray(raw && raw.recurring) ? raw.recurring : []).map(srec1).filter(Boolean).slice(0, RECURRING_MAX),
});

// Новые общие напоминания: обе галочки включены (партнёр может выключить свою)
export const newShrCustom = (it) => ({ ...it, on: { a: true, b: true }, sent: { a: false, b: false } });
export const newShrRec = (it) => ({ ...it, on: { a: true, b: true }, sent: {} });
export const anySent = (it) => !!(it.sent && (it.sent.a || it.sent.b)); // временное общее: отправлено хотя бы одному

// → { shr, etag } (нет записи: пустые списки и etag null). a и b — id пары в любом порядке.
export async function readShr(a, b) {
  const { raw, etag } = await readRec('shr', pairId(a, b));
  return { shr: normShr(raw), etag };
}

// Как mutateRem, но для общей записи пары. fn(shr, me, other): me и other — 'a'/'b' (свой и партнёра для id). Вызывать только после partnerAcc(id).
// Индекс: член p:<id>:<id> пары, счёт — ближайшая отправка любой из двух сторон (у какой стороны привязан Telegram, решает cron).
export async function mutateShr(id, pid, fn, opt) {
  const me = sideOf(id, pid);
  for (let attempt = 0; attempt < 6; attempt++) {
    const { shr, etag } = await readShr(id, pid);
    const before = JSON.stringify(shr);
    const r = fn(shr, me, other(me));
    if (r && r.err) return { shr, err: r.err };
    if (JSON.stringify(shr) === before) return { shr };
    try { await writeRec('shr', pairId(id, pid), shr, etag); }
    catch (e) { if (!isPrecond(e)) throw e; continue; }
    if (!opt || opt.due !== false) await dueTouch(pairMember(id, pid), nextDueShr(shr, mskNow(), ['a', 'b']));
    return { shr };
  }
  throw new Error('shr busy');
}

// Вид для сайта: me — сторона аккаунта ('a'/'b'). on/sent — свои, pon/psent — партнёра.
function pubShr(me, name, shr) {
  const you = other(me), today = mskNow().date, tomorrow = addDays(today, 1);
  return {
    linked: true,
    name,
    custom: shr.custom
      .map((it) => ({ id: it.id, date: it.date, slot: it.slot, text: it.text, on: it.on[me], pon: it.on[you], sent: it.sent[me], psent: it.sent[you] }))
      .sort((x, y) => cmp(x.date + slotKey(x), y.date + slotKey(y))),
    recurring: shr.recurring
      .map((it) => {
        const mine = recDue(it, today) && !!(it.sent[today] && it.sent[today][me]);
        return { id: it.id, date: it.date, every: it.every, slot: it.slot, text: it.text, on: it.on[me], pon: it.on[you], next: recNext(it, mine ? tomorrow : today) };
      })
      .sort((x, y) => cmp((x.next || '9') + slotKey(x), (y.next || '9') + slotKey(y))),
  };
}

// Расписание общих для одной стороны (side): то же, что planRem, но галочка и отметка отправки берутся по стороне.
// Вызывать внутри mutateShr и только для аккаунтов с привязанным Telegram. → [{ kind:'custom'|'rec', cid, text, date }]
export function planShr(shr, now, slot, side) {
  const out = [];
  for (const it of shr.custom) {
    if (!it.on[side] || it.sent[side] || it.date !== now.date) continue;
    if (!slotDue(it, now, slot)) continue;
    it.sent[side] = true;
    out.push({ kind: 'custom', cid: it.id, text: it.text, date: now.date, shared: true });
  }
  for (const it of shr.recurring) {
    if (!it.on[side] || (it.sent[now.date] && it.sent[now.date][side]) || !recDue(it, now.date)) continue;
    if (!slotDue(it, now, slot)) continue;
    it.sent[now.date] = { ...(it.sent[now.date] || { a: false, b: false }), [side]: true };
    out.push({ kind: 'rec', cid: it.id, text: it.text, date: now.date, shared: true });
  }
  const old = addDays(now.date, -60);
  shr.custom = shr.custom.filter((it) => it.date >= old);
  for (const it of shr.recurring) for (const d of Object.keys(it.sent)) if (d < old) delete it.sent[d];
  return out;
}

// Снимает отметку стороны у неудавшихся отправок (элементы planShr).
export function unclaimShr(shr, fails, side) {
  for (const f of fails) {
    if (f.kind === 'rec') {
      const it = shr.recurring.find((x) => x.id === f.cid);
      if (it && it.sent[f.date]) { it.sent[f.date][side] = false; if (!it.sent[f.date].a && !it.sent[f.date].b) delete it.sent[f.date]; }
    } else { const it = shr.custom.find((x) => x.id === f.cid); if (it) it.sent[side] = false; }
  }
}

// Куда писать обработчикам /api/custom и /api/recurring: shared=false — личная запись аккаунта, true — общая запись пары (нужна связь).
// → null (shared, но пары нет) | { sh, mut(fn), out(r) }. mut(fn) для общей вызывает fn(shr, me, other), для личной fn(rem).
// out(r) — тело ответа: то же, что GET /api/reminders.
export async function target(uid, shared) {
  if (!shared) return { sh: false, mut: (fn) => mutateRem(uid, (s) => fn(s)), out: (r) => pubRem(uid, r.rem) };
  const pr = await partnerAcc(uid);
  if (!pr) return null;
  return {
    sh: true,
    mut: (fn) => mutateShr(uid, pr.id, fn),
    out: async (r) => pubRem(uid, (await readRem(uid)).rem, { pr, shr: r.shr }),
  };
}
