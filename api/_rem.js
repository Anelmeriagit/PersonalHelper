// Личные напоминания аккаунта (этап 3b). Ключ Redis rem:<id аккаунта> (с префиксом DB_PREFIX), запись по версии (CAS) через readRec/writeRec.
//   { custom:    [ { id, date:'YYYY-MM-DD', slot:'day'|'evening', text, on, sent:boolean } ],
//     recurring: [ { id, date:'YYYY-MM-DD' (дата отсчёта), every:'week'|'2weeks'|'month', slot, text, on, sent:{'YYYY-MM-DD':true} } ] }
// Получатель один: Telegram, привязанный к аккаунту (tg:<id>, см. _acc.js). Постоянных напоминаний и поля «кому» больше нет.
// Состояние бота (псевдонимы, ожидающие запросы) лежит отдельно, не здесь: бот пишет его на каждое сообщение, а эту запись читает и пишет cron.
// Расписание (recDue, recNext), mskNow, лимиты и EVERY живут здесь; _bot.js их не знает.
import { readRec, writeRec, isPrecond } from './_lib.js';
import { getLink } from './_acc.js';

export const CUSTOM_MAX = 50; // не больше 50 временных напоминаний
export const RECURRING_MAX = 30; // не больше 30 повторяющихся
export const EVERY = ['week', '2weeks', 'month']; // каждую неделю / каждые 2 недели / каждый месяц

/* ---------- время: Москва ---------- */
export function mskNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => parts.find((x) => x.type === t).value;
  const month = g('year') + '-' + g('month');
  return { month, date: month + '-' + g('day') };
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

export const SLOT_HOUR = { day: 14, evening: 18 }; // слоты: после 14:00 и после 18:00 по Москве
export const MAX_DAYS = 370; // чуть больше года вперёд (на сайте 365)
export const MAX_TEXT = 300;

export const hourMsk = () =>
  parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hourCycle: 'h23' }).format(new Date()), 10);

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
  if (!it || !idOk(it.id) || !validDate(it.date) || !own(SLOT_HOUR, it.slot) || typeof it.text !== 'string' || !it.text) return null;
  return { id: it.id, date: it.date, slot: it.slot, text: it.text.slice(0, MAX_TEXT), on: it.on !== false, sent: it.sent === true };
}
function rec1(it) {
  if (!it || !idOk(it.id) || !validDate(it.date) || !own(SLOT_HOUR, it.slot) || !EVERY.includes(it.every) || typeof it.text !== 'string' || !it.text) return null;
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
// → { rem } или { rem, err }
export async function mutateRem(id, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { rem, etag } = await readRem(id);
    const before = JSON.stringify(rem);
    const r = fn(rem);
    if (r && r.err) return { rem, err: r.err };
    if (JSON.stringify(rem) === before) return { rem };
    try { await writeRec('rem', id, rem, etag); return { rem }; }
    catch (e) { if (!isPrecond(e)) throw e; }
  }
  throw new Error('rem busy');
}

/* ---------- вид для сайта ---------- */
const slotKey = (it) => it.slot === 'evening' ? 'b' : 'a';
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

// Ответ всех эндпоинтов напоминаний: { linked, username?, custom, recurring }. linked — привязан ли Telegram к аккаунту;
// username (без @, может быть пустым) есть только у привязанного и берётся из той же записи tg:<id>, что и linked (одна команда Redis):
// блок «Telegram» на сайте показывает @имя из этого ответа и не делает отдельный GET /api/tglink.
export async function pubRem(id, rem) {
  const l = await getLink(id);
  return { linked: !!l, ...(l ? { username: l.un || '' } : {}), custom: publicCustom(rem), recurring: publicRecurring(rem) };
}

/* ---------- расписание ---------- */
// Что отправить сегодня в этом слоте. Меняет rem: помечает отправки заранее, чтобы повторный запуск cron не дублировал.
// → [{ kind:'custom'|'rec', cid, text, date }]. Вызывать внутри mutateRem и только для аккаунтов с привязанным Telegram.
export function planRem(rem, now, slot) {
  const out = [];
  for (const it of rem.custom) {
    if (it.on === false || it.sent || it.date !== now.date) continue;
    if (slot && it.slot !== slot) continue;
    it.sent = true;
    out.push({ kind: 'custom', cid: it.id, text: it.text, date: now.date });
  }
  for (const it of rem.recurring) {
    if (it.on === false || it.sent[now.date] || !recDue(it, now.date)) continue;
    if (slot && it.slot !== slot) continue;
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
