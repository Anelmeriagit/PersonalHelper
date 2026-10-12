import crypto from 'node:crypto';
import { session, renewCookie, readRec, writeRec, isPrecond } from './_lib.js';
import { DEFAULT_TZ, nowIn, zonedToMs, tzOf } from './_tz.js';
import { getAcc } from './_acc.js';

// Страница «Агент»: список строк «приложение — время сброса» в заданном порядке. Ч:мин — по настенным часам пояса аккаунта (этап 5, «Часовые пояса», часть 3; нет поля tz = Москва).
// У строки с часами и минутами есть `at` — момент ближайшего сброса в мс (UTC). Его считает сервер при сохранении:
// это ближайшее такое время по часам пояса аккаунта от момента, когда ч:мин были заданы. Пока ч:мин не менялись, `at` не двигается,
// поэтому прошедший сброс остаётся «прошедшим», а не переезжает на завтра. `at` абсолютный: при смене пояса он остаётся тем же, а ч:мин строк
// пересчитываются из него (retimeRows, set-tz в auth.js). Уведомление о сбросе показывает сам сайт (app.js).
// Парные файлы сайта: js/tz.js (nextAt, retimeRows) и js/local.js (withAt, гостевой агент): менять только вместе.
// app — либо id встроенного приложения, либо своё название (строка до 40 символов, введённая вручную).
export const AGENT_APPS = ['app', 'opera', 'mozilla', 'edge'];
export const AGENT_NAME_MAX = 40;
export const AGENT_MAX = 12; // не больше 12 строк
// Хранилище: Redis, ключ agent:<id аккаунта> (с префиксом DB_PREFIX), у каждого пользователя свой список.
const KIND = 'agent';
const ID_RE = /^[a-z0-9]{1,16}$/;

export const defaults = () => AGENT_APPS.map((app) => ({ id: app, app, h: null, m: null, at: null }));

// Ближайший момент (мс, UTC), когда настенные часы пояса tz (по умолчанию Москва) покажут h:m. Если это время уже наступило (или наступает сейчас), то следующие сутки
// по календарю пояса (не «+24 часа»: в день перехода на летнее время сутки не равны 24 часам).
export function nextAt(h, m, now = Date.now(), tz = DEFAULT_TZ) {
  const today = nowIn(tz, new Date(now)).date;
  const at = zonedToMs(today, h * 60 + m, tz);
  if (at > now) return at;
  const t = new Date(Date.parse(today + 'T00:00:00Z') + 864e5);
  return zonedToMs(t.toISOString().slice(0, 10), h * 60 + m, tz);
}

// Название приложения: встроенный id (в том числе если введено как «Opera») или своё название без спецсимволов.
export function cleanApp(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t || t.length > AGENT_NAME_MAX || /[<>"'`&\\\u0000-\u001f]/.test(t)) return null;
  const low = t.toLowerCase();
  return AGENT_APPS.includes(low) ? low : t; // не LABELS[low]: имена вроде «constructor» дали бы свойство прототипа
}

// Серверная проверка: приложение (из списка или своё), часы 0–23, минуты 0–50 с шагом 10 (или не заданы).
// `at` берётся только из сохранённых данных (keepAt); то, что прислал клиент, игнорируется и считается в withAt.
export function cleanRows(list, keepAt = false) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(list) ? list : []) {
    const app = r && typeof r === 'object' ? cleanApp(r.app) : null;
    if (!app) continue;
    const id = typeof r.id === 'string' && ID_RE.test(r.id) && !seen.has(r.id) ? r.id : crypto.randomBytes(6).toString('hex');
    seen.add(id);
    const h = Number.isInteger(r.h) && r.h >= 0 && r.h <= 23 ? r.h : null;
    const m = Number.isInteger(r.m) && r.m >= 0 && r.m <= 50 && r.m % 10 === 0 ? r.m : null;
    const at = keepAt && h !== null && m !== null && Number.isSafeInteger(r.at) && r.at > 0 ? r.at : null;
    out.push({ id, app, h, m, at });
  }
  return out;
}

// Проставляет `at`: прежний, если ч:мин у строки не менялись, иначе новый (по поясу tz); без ч:мин — null.
export function withAt(rows, prev, now = Date.now(), tz = DEFAULT_TZ) {
  const old = new Map(prev.map((r) => [r.id, r]));
  return rows.map((r) => {
    if (r.h === null || r.m === null) return { ...r, at: null };
    const o = old.get(r.id);
    return { ...r, at: o && o.h === r.h && o.m === r.m && o.at ? o.at : nextAt(r.h, r.m, now, tz) };
  });
}

// Нужен ли пояс для withAt: есть строка с ч:мин, у которой `at` придётся считать заново (PUT без смены времени, например перестановка или смена названия, аккаунт не читает).
const needsTz = (rows, prev) => {
  const old = new Map(prev.map((r) => [r.id, r]));
  return rows.some((r) => { const o = old.get(r.id); return r.h !== null && r.m !== null && !(o && o.h === r.h && o.m === r.m && o.at); });
};

// Смена пояса аккаунта: `at` остаётся тем же моментом, ч:мин строк пересчитываются из него по часам нового пояса. Строка с ч:мин, но без `at` (старая запись,
// клиент ещё не открывал страницу): сначала `at` по старому поясу, чтобы время не «поехало». Минуты на сетке 10 минут (cleanRows): у поясов со смещением
// вроде +05:45 (Катманду) минута округляется вниз до сетки, а `at` остаётся точным (его и показывает/ждёт сайт; withAt не трогает `at`, пока ч:мин не менялись).
export function retimeRows(rows, oldTz, newTz, now = Date.now()) {
  return rows.map((r) => {
    if (r.h === null || r.m === null) return r;
    const at = r.at || nextAt(r.h, r.m, now, oldTz);
    const w = nowIn(newTz, new Date(at));
    return { ...r, h: w.hour, m: Math.floor(w.minute / 10) * 10, at };
  });
}

// Записывает пересчитанные строки аккаунта user (после смены пояса, set-tz в auth.js). Записи нет или строк со временем нет — ничего не пишет.
// → true, если записано. Ошибки пробрасываются (вызывающий решает, отменять ли что-то; set-tz только пишет в журнал).
export async function retimeAgent(user, oldTz, newTz, now = Date.now()) {
  if (oldTz === newTz) return false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { raw, etag } = await readRec(KIND, user);
    if (!raw || !Array.isArray(raw.rows)) return false;
    const rows = cleanRows(raw.rows, true).slice(0, AGENT_MAX);
    const next = retimeRows(rows, oldTz, newTz, now);
    if (JSON.stringify(next) === JSON.stringify(rows)) return false;
    try { await writeRec(KIND, user, { rows: next }, etag); return true; }
    catch (e) { if (!isPrecond(e)) throw e; }
  }
  throw new Error('agent retime busy');
}

// → { rows, etag }: до первого сохранения четыре строки по умолчанию, etag пустой.
async function readRows(user) {
  const { raw, etag } = await readRec(KIND, user);
  return { rows: Array.isArray(raw && raw.rows) ? cleanRows(raw.rows, true).slice(0, AGENT_MAX) : defaults(), etag };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'PUT') return res.status(405).end();
  const user = session(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  const c = renewCookie(req);
  if (c) res.setHeader('Set-Cookie', c);
  try {
    if (req.method === 'GET') return res.status(200).json({ rows: (await readRows(user)).rows });
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    if (!b || !Array.isArray(b.rows)) return res.status(400).json({ error: 'bad request' });
    if (b.rows.length > AGENT_MAX) return res.status(400).json({ error: 'limit' });
    const incoming = cleanRows(b.rows);
    // Последняя запись побеждает, но проходит через проверку версии: если запись пришла между чтением и записью, читаем заново.
    for (let attempt = 0; attempt < 4; attempt++) {
      const { rows: prev, etag } = await readRows(user);
      // Пояс аккаунта читается только если `at` нужно считать заново (+1 команда); иначе PUT стоит столько же, сколько раньше.
      const rows = withAt(incoming, prev, Date.now(), needsTz(incoming, prev) ? tzOf(await getAcc(user)) : DEFAULT_TZ);
      try {
        await writeRec(KIND, user, { rows }, etag);
        return res.status(200).json({ rows });
      } catch (e) {
        if (!isPrecond(e)) throw e;
      }
    }
    return res.status(409).json({ error: 'busy' });
  } catch (e) {
    console.error('agent failed:', e.name);
    return res.status(500).json({ error: 'server' });
  }
}
