import crypto from 'node:crypto';
import { key, getDoc, putDoc, del } from './_db.js';
import { ID_RE } from './_acc.js';

export const BANKS = ['otp', 'alfa', 'vtb', 'halva', 'sber'];
export const CATS = ['АЗС','Авто и автосервис','Активный отдых','Аптеки','Бытовые услуги','Все покупки','Дом и ремонт','Животные и зоотовары','Здоровье и медицина','Кафе и рестораны','Кино и театры','Книги','Красота','Маркетплейсы','Образование','Одежда и обувь','Путешествия','Развлечения','Связь и интернет','Спорт и фитнес','Супермаркеты','Такси и каршеринг','Техника и электроника','Транспорт','Фастфуд','Цветы','Цифровые товары и подписки'];
export const PCTS = ['0.5','1','1.5','2','3','4','5','6','7','8','10','12','15','20','25','30'];

// Ключ подписи сессий: только SESSION_SECRET (≥32 символов). Без него сессий нет.
const secret = () => process.env.SESSION_SECRET || '';
// Смена SESSION_VERSION в настройках Vercel мгновенно разлогинивает все устройства.
const ver = () => String(process.env.SESSION_VERSION || '1');
const sign = (p) => crypto.createHmac('sha256', secret()).update(p).digest('base64url');
const COOKIE = 'cb_session';
const FLAGS = '; HttpOnly; Secure; SameSite=Strict; Path=/';

// user — id аккаунта (32 hex, см. _acc.js).
export function makeCookie(user) {
  if (!secret()) throw new Error('SESSION_SECRET не задан');
  const p = Buffer.from(JSON.stringify({ u: user, e: Date.now() + 30 * 864e5, i: Date.now(), v: ver() })).toString('base64url');
  return `${COOKIE}=${p}.${sign(p)}${FLAGS}; Max-Age=2592000`;
}
export const clearCookie = `${COOKIE}=${FLAGS}; Max-Age=0`;

function parseSession(req) {
  if (!secret()) return null;
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [p, s] = m[1].split('.');
  if (!p || !s) return null;
  const a = Buffer.from(s), b = Buffer.from(sign(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.e > Date.now() && ID_RE.test(String(d.u)) && String(d.v === undefined ? '1' : d.v) === ver() ? d : null;
  } catch { return null; }
}
export function session(req) { const d = parseSession(req); return d ? d.u : null; }
// Если сессии больше 7 дней, выдаём новую cookie на 30 дней (скользящий срок).
export function renewCookie(req) {
  const d = parseSession(req);
  return d && Date.now() - (d.i || 0) > 7 * 864e5 ? makeCookie(d.u) : null;
}

// Серверная проверка: в хранилище попадают только допустимые значения.
export function cleanCustom(list) {
  const out = [];
  const seen = new Set(CATS.map((c) => c.toLowerCase()));
  for (const v of Array.isArray(list) ? list : []) {
    if (typeof v !== 'string') continue;
    const t = v.replace(/\s+/g, ' ').trim();
    if (!t || t.length > 40 || /[<>"'`&\\\u0000-\u001f]/.test(t)) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 30) break;
  }
  return out;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// «Часть» документа — единица версии и конфликтов: месяц ('2026-10') или список своих категорий ('custom').
export const PART_RE = /^(\d{4}-(0[1-9]|1[0-2])|custom)$/;

export function curMonth() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return p.find((x) => x.type === 'year').value + '-' + p.find((x) => x.type === 'month').value;
}
export function shiftMonth(k, n) {
  const [y, m] = k.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

function cleanBlocks(list, allowed) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((b) => b && BANKS.includes(b.bank) && !seen.has(b.bank) && seen.add(b.bank))
    .map((b) => ({
      bank: b.bank,
      items: (Array.isArray(b.items) ? b.items : [])
        .filter((i) => i && allowed.has(i.cat) && PCTS.includes(i.pct))
        .slice(0, 60)
        .map((i) => ({ cat: i.cat, pct: i.pct })),
    }));
}

// Документ: { months: { 'YYYY-MM': [ { bank, items: [{cat, pct}] } ] }, custom: [...] }
export function clean(d) {
  const custom = cleanCustom(d && d.custom);
  const allowed = new Set([...CATS, ...custom]);
  const src = d && d.months && typeof d.months === 'object' ? d.months : {};
  const months = {};
  for (const k of Object.keys(src).filter((k) => MONTH_RE.test(k)).sort().slice(-60)) {
    const v = cleanBlocks(src[k], allowed); // старый формат (объект с zhanna/denis) не массив: такой месяц отбрасывается
    if (v.length) months[k] = v;
  }
  return { months, custom };
}

// Документ кэшбэков одного пользователя: Redis, ключ doc:<id> (с префиксом DB_PREFIX).
// «etag» — номер версии записи в Redis (null, если документа ещё нет).
const dkey = (user) => key('doc', user);

export const cleanRev = (r) => {
  const out = {};
  for (const [k, v] of Object.entries(r && typeof r === 'object' ? r : {})) {
    if (PART_RE.test(k) && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  return out;
};
// Ошибка «версия в базе уже другая» (чужая запись). Имя содержит «Precondition», его узнаёт isPrecond.
export const isPrecond = (e) => /precondition|already\s*exists/i.test(String(e && (e.name + ' ' + e.message)));
const fresh = () => ({ ...clean({}), rev: {} });

export async function readDoc(user) {
  const { doc: raw, v } = await getDoc(dkey(user));
  if (!raw) return { doc: fresh(), etag: null };
  return { doc: { ...clean(raw), rev: cleanRev(raw.rev) }, etag: v };
}

// Запись только если версия в базе совпала с etag, прочитанным до этого (для нового документа etag пустой).
export async function writeDoc(user, doc, etag) {
  const n = await putDoc(dkey(user), doc, etag || 0);
  if (n === null) { const e = new Error('Precondition failed: version mismatch'); e.name = 'PreconditionFailedError'; throw e; }
  return { etag: n };
}

export const loadDoc = readDoc;

// Прочие личные данные пользователя (агент, Wi-Fi): отдельная запись на раздел, ключ <kind>:<id> с префиксом DB_PREFIX.
// Версия и запись по версии те же, что у документа кэшбэков: чужую запись не затереть. raw — как лежит в Redis (null, если записи нет).
export async function readRec(kind, user) {
  const { doc, v } = await getDoc(key(kind, user));
  return { raw: doc, etag: doc ? v : null };
}
export const dropRec = (kind, user) => del(key(kind, user));
export async function writeRec(kind, user, obj, etag) {
  const n = await putDoc(key(kind, user), obj, etag || 0);
  if (n === null) { const e = new Error('Precondition failed: version mismatch'); e.name = 'PreconditionFailedError'; throw e; }
  return { etag: n };
}
