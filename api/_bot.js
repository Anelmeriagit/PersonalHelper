import crypto from 'node:crypto';
import * as B from '@vercel/blob';
import { loadDoc, isPrecond, shiftMonth } from './_lib.js';
import { validCats, own } from './_shops.js';
const { get, put, head } = B;

/* ---------- люди (бот отвечает только им) ---------- */
export const PERSONS = {
  denis: { name: 'Денис', username: 'anelmeria' },
  zhanna: { name: 'Жанна', username: 'zhannaradeeva' },
};
export function personOf(from) {
  const u = String((from && from.username) || '').toLowerCase();
  return Object.keys(PERSONS).find((k) => PERSONS[k].username === u) || null;
}

/* ---------- время: Москва ---------- */
export function mskNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => parts.find((x) => x.type === t).value;
  const month = g('year') + '-' + g('month');
  return { month, date: month + '-' + g('day') };
}

/* ---------- напоминания ---------- */
// Цикл = календарный месяц ('YYYY-MM'). Состояние каждого цикла хранится отдельно,
// поэтому в новом месяце всё начинается заново.
const pad = (n) => String(n).padStart(2, '0');
const daysIn = (cm) => { const [y, m] = cm.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const days = (cm, list) => list.map((d) => cm + '-' + pad(d));
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const eachDay = (a, b) => { const out = []; for (let t = a; t <= b; t += 864e5) out.push(iso(t)); return out; };
// Все дни месяца
const wholeMonth = (cm) => { const [y, m] = cm.split('-').map(Number); return eachDay(Date.UTC(y, m - 1, 1), Date.UTC(y, m - 1, daysIn(cm))); };
// С 23 числа месяца до 22 числа следующего (включительно)
const from23 = (cm) => { const [y, m] = cm.split('-').map(Number); return eachDay(Date.UTC(y, m - 1, 23), Date.UTC(y, m, 22)); };
const okBtn = (id, label) => (cm) => [[{ text: label, callback_data: `ok|${id}|${cm}` }]];

export const TEST_CYCLE = '2000-01'; // тестовый цикл для ручной проверки (/api/cron?send=...)

export const REMINDERS = {
  cashback: {
    who: ['denis', 'zhanna'],
    title: 'Выбор кешбэка',
    text: 'Привет! Не забудь выбрать кешбэк на новый период.',
    slot: 'evening', // 18:00–19:00 МСК
    // 25 и 28 числа + последний раз на следующий день (29-го; если 29-го нет — 1-го числа следующего месяца)
    dates: (cm) => days(cm, [25, 28]).concat(daysIn(cm) >= 29 ? [cm + '-29'] : [shiftMonth(cm, 1) + '-01']),
    buttons: okBtn('cashback', 'Готово'),
    doneText: 'Проверка пройдена ✅ Категории на сайте заполнены.',
  },
  meters: {
    who: ['denis', 'zhanna'],
    title: 'Счётчики',
    text: 'Привет! Отправь счётчики.',
    slot: 'evening', // 18:00–19:00 МСК
    firstCycle: '2026-10', // первый цикл начинается 23.10.2026; прошлые месяцы не напоминаем
    // с 23 числа каждый день, пока человек не нажмёт «Готово»; цикл заканчивается 22-го следующего месяца
    dates: from23,
    buttons: okBtn('meters', 'Готово'),
    doneLabel: 'Готово',
  },
  halva: {
    who: ['denis', 'zhanna'],
    title: 'Потратить Халву',
    text: 'Привет! Надо потратить Халву.',
    slot: 'day', // 14:00–15:00 МСК
    dates: (cm) => days(cm, [7, 12, 17, 22, 27]),
    buttons: (cm) => [[
      { text: 'Напомнить позже', callback_data: `later|halva|${cm}` },
      { text: 'Всё потрачено', callback_data: `ok|halva|${cm}` },
    ]],
    doneLabel: 'Всё потрачено',
  },
  mortgage: {
    who: ['denis'],
    title: 'Закинуть ипотеку',
    text: 'Привет! Надо закинуть ипотеку.',
    slot: 'day', // 14:00–15:00 МСК
    dates: (cm) => days(cm, [22]),
    buttons: okBtn('mortgage', 'Готово'),
    doneLabel: 'Готово',
  },
  daily: {
    who: ['zhanna'],
    title: 'Ежедневное напоминание',
    text: 'Бить Денису жопу',
    slot: 'day', // 14:00–15:00 МСК
    dates: wholeMonth, // каждый день, без кнопок и без «выполнено»
  },
};

/* ---------- состояние (Vercel Blob) ---------- */
// { users: { denis: {chat, username}, ... },
//   settings: { cashback: { on, denis, zhanna }, ... },
//   cycles: { 'halva:2026-10': { done: { denis: true }, sent: { '2026-10-05': ['denis'] } } },
//   custom: [ { id, date: '2026-10-05', slot: 'day'|'evening', text, who: ['denis'], on: true, sent: { denis: true } } ],
//   recurring: [ { id, date: '2026-10-05' (первое срабатывание), every: 'week'|'2weeks'|'month', slot, text, who, on, sent: { '2026-10-12': ['denis'] } } ],
//   alias: { 'ключ': { c: 'Категория', t: 'Название', at: 1760000000000 } }   // общие псевдонимы и исправления магазинов, до 200
//   pending: { 'abcd1234': { q: 'текст запроса', ts: 1760000000000, l: ['Категория', ...], f: 3, m: 'fix' } } }  // ожидающие запросы с кнопками, до 50, живут 1 сутки
const PATH = 'bot/state.json';
export const CUSTOM_MAX = 50; // не больше 50 временных напоминаний
export const RECURRING_MAX = 30; // не больше 30 повторяющихся
export const EVERY = ['week', '2weeks', 'month']; // каждую неделю / каждые 2 недели / каждый месяц
export const ALIAS_MAX = 200; // не больше 200 псевдонимов (вытесняются самые старые)
export const PENDING_MAX = 50; // не больше 50 ожидающих запросов (вытесняются самые старые)
export const PENDING_TTL = 864e5; // ожидающий запрос живёт 1 сутки
const fresh = () => ({ users: {}, settings: {}, cycles: {}, custom: [], recurring: [], alias: {}, pending: {} });
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const norm = (raw) => ({ users: obj(raw && raw.users), settings: obj(raw && raw.settings), cycles: obj(raw && raw.cycles), custom: Array.isArray(raw && raw.custom) ? raw.custom : [], recurring: Array.isArray(raw && raw.recurring) ? raw.recurring : [], alias: obj(raw && raw.alias), pending: obj(raw && raw.pending) });
const isMissing = (e) => /not\s*found|404/i.test(String(e && (e.message || e.name)));

export async function readState() {
  try {
    const r = await get(PATH, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return { state: fresh(), etag: null };
    const raw = JSON.parse(await new Response(r.stream).text());
    let etag = r.blob && r.blob.etag;
    if (!etag) etag = (await head(PATH)).etag;
    return { state: norm(raw), etag };
  } catch (e) {
    if (isMissing(e)) return { state: fresh(), etag: null };
    throw e;
  }
}

async function writeState(state, etag, force) {
  const body = JSON.stringify(state);
  const base = { access: 'private', addRandomSuffix: false, contentType: 'application/json' };
  if (force) return put(PATH, body, { ...base, allowOverwrite: true });
  if (etag) return put(PATH, body, { ...base, allowOverwrite: true, ifMatch: etag });
  return put(PATH, body, { ...base, allowOverwrite: false });
}

// Читает состояние, применяет fn(state) (она меняет объект и может вернуть результат), записывает.
// При гонке (чужая запись) повторяет с свежим состоянием.
export async function mutate(fn) {
  let prevSig = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { state, etag } = await readState();
    const before = JSON.stringify(state);
    const result = fn(state);
    if (JSON.stringify(state) === before) return result;
    // ETag не совпал, а содержимое с прошлой попытки то же -> чужой записи не было, пишем без ifMatch.
    const force = prevSig !== null && before === prevSig;
    try {
      await writeState(state, etag, force);
      return result;
    } catch (e) {
      if (!isPrecond(e)) throw e;
      prevSig = before;
    }
  }
  throw new Error('state busy');
}

/* ---------- настройки и расписание ---------- */
export function enabled(state, id, p) {
  const s = obj(state.settings[id]);
  return s.on !== false && s[p] !== false;
}

export function publicSettings(state) {
  const out = {};
  for (const [id, R] of Object.entries(REMINDERS)) {
    const s = obj(state.settings[id]);
    out[id] = { on: s.on !== false };
    for (const p of R.who) out[id][p] = s[p] !== false;
  }
  return out;
}

// Временные напоминания для сайта: по порядку даты и времени.
export function publicCustom(state) {
  const key = (it) => it.date + (it.slot === 'evening' ? 'b' : 'a');
  return state.custom
    .filter((it) => it && typeof it.id === 'string' && Array.isArray(it.who) && typeof it.text === 'string')
    .map((it) => ({
      id: it.id, date: it.date, slot: it.slot, text: it.text, who: it.who.slice(), on: it.on !== false,
      sent: Object.fromEntries(it.who.map((p) => [p, !!(it.sent && it.sent[p])])),
    }))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// Повторяющиеся: срабатывают в стартовую дату и дальше каждые 7 / 14 дней или раз в месяц в то же число
// (если такого числа в месяце нет, например 31-го, то в последний день месяца).
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
export function publicRecurring(state) {
  const today = mskNow().date;
  const tomorrow = iso(Date.parse(today + 'T00:00:00Z') + 864e5);
  return state.recurring
    .filter((it) => it && typeof it.id === 'string' && EVERY.includes(it.every) && Array.isArray(it.who) && typeof it.text === 'string' && typeof it.date === 'string')
    .map((it) => {
      const st = it.sent && Array.isArray(it.sent[today]) ? it.sent[today] : [];
      const doneToday = recDue(it, today) && it.who.length > 0 && it.who.every((p) => st.includes(p));
      return { id: it.id, date: it.date, every: it.every, slot: it.slot, text: it.text, who: it.who.slice(), on: it.on !== false, next: recNext(it, doneToday ? tomorrow : today) };
    })
    .sort((a, b) => { const x = (a.next || '9') + (a.slot === 'evening' ? 'b' : 'a'), y = (b.next || '9') + (b.slot === 'evening' ? 'b' : 'a'); return x < y ? -1 : x > y ? 1 : 0; });
}

export const linkedOf = (state) => ({ denis: !!(state.users.denis && state.users.denis.chat), zhanna: !!(state.users.zhanna && state.users.zhanna.chat) });

export const pubState = (state) => ({ settings: publicSettings(state), linked: linkedOf(state), custom: publicCustom(state), recurring: publicRecurring(state) });

// Что отправить сегодня. Меняет state: помечает отправки заранее, чтобы повторный запуск cron не дублировал.
export function planDue(state, now, slot) {
  const out = [];
  for (const [id, R] of Object.entries(REMINDERS)) {
    if (slot && (R.slot || 'day') !== slot) continue;
    // текущий и прошлый месяц: последнее напоминание «кэшбэка» в коротком феврале выпадает на 1 марта
    for (const cm of [now.month, shiftMonth(now.month, -1)]) {
      if (R.firstCycle && cm < R.firstCycle) continue;
      if (!R.dates(cm).includes(now.date)) continue;
      const key = id + ':' + cm;
      const c = state.cycles[key] || { done: {}, sent: {} };
      for (const p of R.who) {
        if (!enabled(state, id, p) || c.done[p]) continue;
        const chat = state.users[p] && state.users[p].chat;
        if (!chat) continue;
        const sent = c.sent[now.date] || (c.sent[now.date] = []);
        if (sent.includes(p)) continue;
        sent.push(p);
        state.cycles[key] = c;
        out.push({ id, p, cycle: cm, chat, date: now.date });
      }
    }
  }
  // Временные напоминания: только на сегодня и в своём слоте; отметка «отправлено» ставится заранее, как у постоянных.
  for (const it of state.custom) {
    if (!it || it.on === false || it.date !== now.date || !Array.isArray(it.who)) continue;
    if (slot && it.slot !== slot) continue;
    const sent = it.sent && typeof it.sent === 'object' ? it.sent : (it.sent = {});
    for (const p of it.who) {
      const chat = state.users[p] && state.users[p].chat;
      if (!chat || sent[p]) continue;
      sent[p] = true;
      out.push({ id: 'custom', cid: it.id, custom: true, text: it.text, p, chat, date: now.date });
    }
  }
  // Повторяющиеся: если сегодня день срабатывания и слот подходит; отметки по датам хранятся в sent[дата] = [кому].
  for (const it of state.recurring) {
    if (!it || it.on === false || !Array.isArray(it.who) || !recDue(it, now.date)) continue;
    if (slot && it.slot !== slot) continue;
    for (const p of it.who) {
      const chat = state.users[p] && state.users[p].chat;
      if (!chat) continue;
      const sa = it.sent && typeof it.sent === 'object' ? it.sent : (it.sent = {});
      const sent = Array.isArray(sa[now.date]) ? sa[now.date] : (sa[now.date] = []);
      if (sent.includes(p)) continue;
      sent.push(p);
      out.push({ id: 'recurring', cid: it.id, custom: true, rec: true, text: it.text, p, chat, date: now.date });
    }
  }
  const oldSent = iso(Date.parse(now.date + 'T00:00:00Z') - 60 * 864e5);
  for (const it of state.recurring) if (it && it.sent && typeof it.sent === 'object') for (const d of Object.keys(it.sent)) if (d < oldSent) delete it.sent[d];
  // Старше 60 дней — убираем, чтобы список не рос.
  const old = iso(Date.parse(now.date + 'T00:00:00Z') - 60 * 864e5);
  state.custom = state.custom.filter((it) => it && typeof it.date === 'string' && it.date >= old);
  const lo = shiftMonth(now.month, -4);
  for (const k of Object.keys(state.cycles)) if (String(k.split(':')[1]) < lo) delete state.cycles[k];
  return out;
}

export function markDone(id, cm, p) {
  return mutate((st) => {
    const k = id + ':' + cm;
    const c = st.cycles[k] || (st.cycles[k] = { done: {}, sent: {} });
    c.done[p] = true;
  });
}

/* ---------- проверка заполнения на сайте ---------- */
export const targetMonth = (cm) => (cm === TEST_CYCLE ? shiftMonth(mskNow().month, 1) : shiftMonth(cm, 1));

export async function isFilled(person, month) {
  const { doc } = await loadDoc(process.env.AUTH_USER);
  const list = (doc.months[month] && doc.months[month][person]) || [];
  return list.some((b) => (b.items || []).some((i) => i.cat && i.pct));
}

/* ---------- текст «Показать кэшбэки» ---------- */
const BANK_NAMES = { otp: 'ОТП', alfa: 'Альфа', vtb: 'ВТБ', halva: 'Халва', sber: 'Сбер' };
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const monthLabel = (k) => { const [y, m] = k.split('-'); return MONTHS[+m - 1] + ' ' + y; };
const PEOPLE_ORDER = ['zhanna', 'denis']; // как на сайте: сначала Жанна, потом Денис
const pctText = (v) => String(v).replace('.', ',') + '%';

// Заполненные строки человека за месяц: [{bank, cat, v}]
export function filledRows(doc, month, p) {
  const out = [];
  for (const b of (doc.months[month] && doc.months[month][p]) || []) {
    for (const i of (b && b.items) || []) {
      const v = parseFloat(i && i.pct);
      if (i && i.cat && i.pct && Number.isFinite(v)) out.push({ bank: b.bank, cat: i.cat, v });
    }
  }
  return out;
}
export const blocksOf = (doc, month, p) => filledRows(doc, month, p);

// Заполненные строки месяца по категориям: { категория: [{p, bank, v}] }; люди в порядке PEOPLE_ORDER.
export function catRows(doc, mo) {
  const g = {};
  for (const p of PEOPLE_ORDER) for (const r of filledRows(doc, mo, p)) (g[r.cat] = g[r.cat] || []).push({ p, bank: r.bank, v: r.v });
  return g;
}

// Строки процентов одной категории (общая для /cashback и ответа по магазину): по убыванию процента,
// банки с одним процентом в одной строке. ✅ у лучшего процента, если пар «человек + банк» больше одной (mark=false: без ✅).
export function pctLines(rows, mark = true) {
  const multi = new Set(rows.map((r) => r.p + '|' + r.bank)).size > 1;
  const best = Math.max(...rows.map((r) => r.v));
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.v)) groups.set(r.v, {});
    const by = groups.get(r.v);
    (by[r.p] = by[r.p] || []).push(BANK_NAMES[r.bank] || r.bank);
  }
  return [...groups.keys()].sort((a, b) => b - a).map((v) => {
    const by = groups.get(v);
    const who = PEOPLE_ORDER.filter((p) => by[p]).map((p) => PERSONS[p].name + ': ' + by[p].join(', ')).join(' · ');
    return (mark && multi && v === best ? '✅ ' : '') + pctText(v) + ' — ' + who;
  });
}

// Одно сообщение на месяц, как компактный вид на сайте:
// категории по алфавиту, под каждой строки по убыванию процента; банки с одним процентом в одной строке.
// ✅ у лучшего процента, если в категории есть из чего выбирать (больше одной пары «человек + банк»).
export function monthText(doc, mo) {
  const g = catRows(doc, mo);
  const cats = Object.keys(g).sort((a, b) => a.localeCompare(b, 'ru'));
  const head = 'Кэшбэки, ' + monthLabel(mo);
  if (!cats.length) return head + '\n\nПока не заполнено';
  const blocks = cats.map((c) => c + '\n' + pctLines(g[c]).join('\n'));
  const missing = PEOPLE_ORDER.filter((p) => !filledRows(doc, mo, p).length).map((p) => PERSONS[p].name);
  return head + '\n\n' + blocks.join('\n\n') + (missing.length ? '\n\n' + missing.join(', ') + ': пока не заполнено' : '');
}

// «У вас нет категории фастфуд»: название категории с маленькой буквы, кроме аббревиатур (АЗС) — у них вторая буква тоже заглавная.
const lowFirst = (c) => (c.length > 1 && c[1] !== c[1].toLowerCase() ? c : c.charAt(0).toLowerCase() + c.slice(1));
export const noCategory = (c) => 'У вас нет категории ' + lowFirst(c);

// Ответ на название магазина или категории. res — результат lookup() из _shops.js.
// Одна категория: полный список как в /cashback. Несколько: по одной лучшей строке на категорию.
// «Все покупки» добавляется запасной строкой (лучший процент), если это не сама запрошенная категория.
export function shopText(doc, mo, res) {
  if (res.kind === 'ambiguous') {
    const n = res.names;
    const who = n.length <= 4 ? n.join(' или ') : n.slice(0, 3).join(', ') + ' и ещё ' + (n.length - 3);
    return 'Не знаю точно: ' + who + '. Напишите название полностью или название категории.';
  }
  if (res.kind !== 'found') return 'Не знаю такой магазин. Напишите название категории, например «Супермаркеты» или «Кафе и рестораны».';
  const g = catRows(doc, mo);
  const out = [];
  if (res.cats.length === 1) {
    const c = res.cats[0];
    out.push(res.title === c ? c : res.title + ' · ' + c);
    out.push(...(g[c] ? pctLines(g[c]) : [noCategory(c)]));
  } else {
    out.push(res.title);
    for (const c of res.cats) out.push(c + ': ' + (g[c] ? pctLines(g[c])[0] : 'нет категории'));
  }
  if (!res.cats.includes('Все покупки') && g['Все покупки']) out.push('Все покупки: ' + pctLines(g['Все покупки'], false)[0]);
  return out.join('\n');
}

/* ---------- обучение бота: псевдонимы и ожидающие запросы (все функции меняют state, вызывать внутри mutate) ---------- */
// Ожидающий запрос: короткий id в callback_data -> { q: текст пользователя, ts, l: снимок списка категорий, f: сколько из них «заполненных», m: 'fix' }.
// Снимок l нужен, потому что в callback_data идёт индекс, а список категорий (своя категория на сайте) может измениться.
export function pendingGet(state, id, now) {
  const e = own(state.pending, id);
  return e && typeof e.q === 'string' && typeof e.ts === 'number' && e.ts > now - PENDING_TTL ? e : null;
}
// Создаёт ожидающий запрос или обновляет уже существующий с тем же текстом. extra: поля для записи (null удаляет поле).
export function pendingPut(state, q, now, extra) {
  const P = state.pending;
  for (const k of Object.keys(P)) if (!pendingGet(state, k, now)) delete P[k];
  let id = Object.keys(P).find((k) => P[k].q === q);
  if (!id) { do { id = crypto.randomBytes(4).toString('hex'); } while (own(P, id)); P[id] = { q, ts: now }; }
  const e = P[id];
  e.ts = now;
  for (const k of Object.keys(extra || {})) { if (extra[k] == null) delete e[k]; else e[k] = extra[k]; }
  const ids = Object.keys(P).sort((a, b) => P[a].ts - P[b].ts);
  while (ids.length > PENDING_MAX) delete P[ids.shift()];
  return id;
}
export function aliasSet(state, key, cat, title, now) {
  const A = state.alias;
  A[key] = { c: cat, t: String(title || '').slice(0, 60), at: now };
  const keys = Object.keys(A).sort((a, b) => ((A[a] && A[a].at) || 0) - ((A[b] && A[b].at) || 0));
  while (keys.length > ALIAS_MAX) delete A[keys.shift()];
}
export function aliasDel(state, key) { if (own(state.alias, key)) delete state.alias[key]; }

// Категории для кнопок: сначала те, где в этом месяце кто-то заполнил кэшбэк (по алфавиту), затем остальные (порядок CATS, потом свои).
// list — все названия, f — сколько из них «заполненных» (они идут первыми).
export function catChoices(doc, mo) {
  const all = validCats(doc && doc.custom);
  const g = catRows(doc, mo);
  const filled = Object.keys(g).filter((c) => all.includes(c)).sort((a, b) => a.localeCompare(b, 'ru'));
  return { list: filled.concat(all.filter((c) => !filled.includes(c))), f: filled.length };
}

// Кнопки. callback_data: действие|id запроса|индекс — не длиннее 64 байт, текста там нет.
//  sk — выбрать категорию l[i]; so — показать остальные; sp — вернуться к первому списку; sf — «Не та категория»; sr — сбросить к словарю; sb — отмена.
export const shopKb = (id, hasAlias) => [[{ text: 'Не та категория', callback_data: 'sf|' + id }]].concat(hasAlias ? [[{ text: 'Сбросить к словарю', callback_data: 'sr|' + id }]] : []);
export function pickKb(id, l, f, other, cancel) {
  const first = !other && f > 0;
  const from = other ? f : 0, to = first ? f : l.length; // другая: остальные; нет «заполненных»: все
  const kb = [];
  for (let i = from; i < to; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, to); j++) row.push({ text: l[j], callback_data: 'sk|' + id + '|' + j });
    kb.push(row);
  }
  if (first && l.length > f) kb.push([{ text: 'Другая…', callback_data: 'so|' + id }]);
  if (other) kb.push([{ text: '← Назад', callback_data: 'sp|' + id }]);
  if (cancel) kb.push([{ text: 'Отмена', callback_data: 'sb|' + id }]);
  return kb;
}

// Тексты сообщений: текущий месяц и, если кто-то уже заполнил, следующий.
export function cashbackTexts(doc, curMonth) {
  const months = [curMonth];
  const nxt = shiftMonth(curMonth, 1);
  if (PEOPLE_ORDER.some((p) => filledRows(doc, nxt, p).length)) months.push(nxt);
  return months.map((mo) => monthText(doc, mo));
}

// Telegram принимает не больше 4096 символов в сообщении: режем по строкам.
export function chunkText(text, max = 3800) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && (cur + '\n' + line).length > max) { out.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

/* ---------- Telegram ---------- */
const token = () => process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
export const webhookSecret = () => crypto.createHash('sha256').update('wh:' + token()).digest('hex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Запрос к Telegram: таймаут 10 с, повтор при сетевой ошибке, 429 (с учётом retry_after) и 5xx.
export async function tg(method, payload, { retries = 2 } = {}) {
  if (!token()) throw new Error('Не задан TELEGRAM_BOT_TOKEN');
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
        signal: AbortSignal.timeout(10000),
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) return j.result;
      const err = new Error(j.description || 'telegram ' + r.status);
      err.api = true;
      last = err;
      if ((r.status === 429 || r.status >= 500) && attempt < retries) {
        await sleep(Math.min(((j.parameters && j.parameters.retry_after) || attempt + 1) * 1000, 5000));
        continue;
      }
      throw err;
    } catch (e) {
      if (e.api) throw e;
      last = e;
      if (attempt < retries) { await sleep(1000 * (attempt + 1)); continue; }
      throw e;
    }
  }
  throw last;
}

export function sendReminder(chat, id, cycle) {
  const R = REMINDERS[id];
  const body = { chat_id: chat, text: R.text };
  if (R.buttons) body.reply_markup = { inline_keyboard: R.buttons(cycle) };
  return tg('sendMessage', body);
}

export const sendCustom = (chat, text) => tg('sendMessage', { chat_id: chat, text: '🔔 ' + text });

export function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Меню бота (кнопка «Меню» слева от поля ввода)
export const BOT_COMMANDS = [{ command: 'cashback', description: 'Показать кэшбэки' }];

// Доступ к служебным адресам (/api/cron, /api/tg-setup): тот же CRON_SECRET, который Vercel шлёт в cron.
export function authed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const h = String(req.headers.authorization || '');
  const key = h.startsWith('Bearer ') ? h.slice(7) : ''; // только заголовок: секрет не попадает в URL и логи
  return safeEq(key, secret);
}

// Сообщение администратору (Денису) в Telegram. Никогда не бросает исключение.
export async function notifyAdmin(text) {
  try {
    const { state } = await readState();
    const chat = state.users.denis && state.users.denis.chat;
    if (!chat) return false;
    await tg('sendMessage', { chat_id: chat, text }, { retries: 1 });
    return true;
  } catch (e) {
    console.error('notify failed', e.message);
    return false;
  }
}

// Снимает отметку «отправлено» у неудавшихся отправок: ручной повтор /api/cron отправит их снова.
export function unclaim(fails) {
  return mutate((st) => {
    for (const f of fails) {
      if (f.rec) {
        const it = st.recurring.find((x) => x && x.id === f.cid);
        const s = it && it.sent && it.sent[f.date];
        const i = Array.isArray(s) ? s.indexOf(f.p) : -1;
        if (i > -1) s.splice(i, 1);
        continue;
      }
      if (f.custom) {
        const it = st.custom.find((x) => x && x.id === f.cid);
        if (it && it.sent) delete it.sent[f.p];
        continue;
      }
      const s = st.cycles[f.id + ':' + f.cycle] && st.cycles[f.id + ':' + f.cycle].sent && st.cycles[f.id + ':' + f.cycle].sent[f.date];
      const i = s ? s.indexOf(f.p) : -1;
      if (i > -1) s.splice(i, 1);
    }
  });
}

// Определяет человека по числовому Telegram id. Пока id не сохранён (первый раз), доверяем username
// и сразу запоминаем id; после этого смена или перехват username уже ничего не даёт.
export async function whoIs(from) {
  if (!from || !from.id) return null;
  const { state } = await readState();
  const keys = Object.keys(PERSONS);
  const byId = keys.find((k) => state.users[k] && state.users[k].id === from.id);
  if (byId) return byId;
  const uname = String(from.username || '').toLowerCase();
  const k = keys.find((x) => PERSONS[x].username === uname && !(state.users[x] && state.users[x].id));
  if (!k) return null;
  if (state.users[k]) await mutate((st) => { if (st.users[k] && !st.users[k].id) st.users[k].id = from.id; });
  return k;
}
