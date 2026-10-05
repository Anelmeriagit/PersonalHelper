// Логика бота: тексты кэшбэков и ответов по магазинам, обучение (псевдонимы, ожидающие запросы), вызовы Telegram.
// Бот знает человека только по привязке Telegram к аккаунту (tgu:<tid>, см. _acc.js). Напоминания и их расписание: _rem.js.
import crypto from 'node:crypto';
import { readRec, writeRec, isPrecond, shiftMonth } from './_lib.js';
import { validCats, own } from './_shops.js';

/* ---------- состояние бота одного аккаунта (Redis, ключ bot:<id>) ---------- */
// { alias: { 'ключ': { c: 'Категория', t: 'Название', at: 1760000000000 } },   // личные псевдонимы и исправления магазинов, до 200
//   pending: { 'abcd1234': { q: 'текст запроса', ts: 1760000000000, l: ['Категория', ...], f: 3, m: 'fix' } } }  // ожидающие запросы с кнопками, до 50, живут 1 сутки
// Записывает только бот (telegram.js), на каждое сообщение; напоминания лежат отдельно (rem:<id>), cron сюда не пишет.
export const ALIAS_MAX = 200; // не больше 200 псевдонимов (вытесняются самые старые)
export const PENDING_MAX = 50; // не больше 50 ожидающих запросов (вытесняются самые старые)
export const PENDING_TTL = 864e5; // ожидающий запрос живёт 1 сутки
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// norm обязан перечислять все поля состояния: неперечисленное теряется при первой же записи. Новое поле: добавить сюда и в заметки.
export const normBot = (raw) => ({ alias: obj(raw && raw.alias), pending: obj(raw && raw.pending) });

// → { state, etag } (нет записи: пустое состояние и etag null)
export async function readBot(id) {
  const { raw, etag } = await readRec('bot', id);
  return { state: normBot(raw), etag };
}

// Читает состояние, применяет fn(state) (она меняет объект и может вернуть результат), пишет по версии.
// Чужая запись между чтением и записью (два сообщения подряд): повтор со свежими данными, до 6 раз.
export async function mutateBot(id, fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { state, etag } = await readBot(id);
    const before = JSON.stringify(state);
    const result = fn(state);
    if (JSON.stringify(state) === before) return result;
    try { await writeRec('bot', id, state, etag); return result; }
    catch (e) { if (!isPrecond(e)) throw e; }
  }
  throw new Error('bot state busy');
}

/* ---------- текст «Показать кэшбэки» ---------- */
const BANK_NAMES = { otp: 'ОТП', alfa: 'Альфа', vtb: 'ВТБ', halva: 'Халва', sber: 'Сбер' };
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const monthLabel = (k) => { const [y, m] = k.split('-'); return MONTHS[+m - 1] + ' ' + y; };
const pctText = (v) => String(v).replace('.', ',') + '%';

// Заполненные строки месяца: [{bank, cat, v}]. Формат документа: months[месяц] = [{bank, items:[{cat, pct}]}].
export function filledRows(doc, month) {
  const out = [];
  for (const b of doc.months[month] || []) {
    for (const i of (b && b.items) || []) {
      const v = parseFloat(i && i.pct);
      if (i && i.cat && i.pct && Number.isFinite(v)) out.push({ bank: b.bank, cat: i.cat, v });
    }
  }
  return out;
}

// Заполненные строки месяца по категориям: { категория: [{bank, v}] }.
export function catRows(doc, mo) {
  const g = {};
  for (const r of filledRows(doc, mo)) (g[r.cat] = g[r.cat] || []).push({ bank: r.bank, v: r.v });
  return g;
}

// Строки процентов одной категории (общая для /cashback и ответа по магазину): по убыванию процента,
// банки с одним процентом в одной строке. ✅ у лучшего процента, если банков больше одного (mark=false: без ✅).
export function pctLines(rows, mark = true) {
  const multi = new Set(rows.map((r) => r.bank)).size > 1;
  const best = Math.max(...rows.map((r) => r.v));
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.v)) groups.set(r.v, []);
    groups.get(r.v).push(BANK_NAMES[r.bank] || r.bank);
  }
  return [...groups.keys()].sort((a, b) => b - a).map((v) => (mark && multi && v === best ? '✅ ' : '') + pctText(v) + ' — ' + groups.get(v).join(', '));
}

// Одно сообщение на месяц, как компактный вид на сайте:
// категории по алфавиту, под каждой строки по убыванию процента; банки с одним процентом в одной строке.
// ✅ у лучшего процента, если в категории есть из чего выбирать (больше одного банка).
export function monthText(doc, mo) {
  const g = catRows(doc, mo);
  const cats = Object.keys(g).sort((a, b) => a.localeCompare(b, 'ru'));
  const head = 'Кэшбэки, ' + monthLabel(mo);
  if (!cats.length) return head + '\n\nПока не заполнено';
  const blocks = cats.map((c) => c + '\n' + pctLines(g[c]).join('\n'));
  return head + '\n\n' + blocks.join('\n\n');
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

// Категории для кнопок: сначала те, где в этом месяце заполнен кэшбэк (по алфавиту), затем остальные (порядок CATS, потом свои).
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

// Тексты сообщений: текущий месяц и, если следующий уже заполнен, он тоже.
export function cashbackTexts(doc, curMonth) {
  const months = [curMonth];
  const nxt = shiftMonth(curMonth, 1);
  if (filledRows(doc, nxt).length) months.push(nxt);
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

// Username бота для ссылки привязки: getMe, кэш в памяти экземпляра (новый токен = новый деплой). Пустая строка, если не вышло.
let botUser = '';
export async function botUsername() {
  if (botUser) return botUser;
  const me = await tg('getMe', {}, { retries: 1 });
  const u = me && typeof me.username === 'string' && /^[A-Za-z0-9_]{5,32}$/.test(me.username) ? me.username : '';
  if (u) botUser = u;
  return u;
}

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
