import crypto from 'node:crypto';
import * as B from '@vercel/blob';
import { session, renewCookie } from './_lib.js';
const { get, put } = B;

// Страница «Агент»: список строк «приложение — время сброса» в заданном порядке. Время по Москве.
// У строки с часами и минутами есть `at` — момент ближайшего сброса в мс (UTC). Его считает сервер при сохранении:
// это ближайшее такое время по Москве от момента, когда ч:мин были заданы. Пока ч:мин не менялись, `at` не двигается,
// поэтому прошедший сброс остаётся «прошедшим», а не переезжает на завтра. Уведомление о сбросе показывает сам сайт (app.js).
// app — либо id встроенного приложения, либо своё название (строка до 40 символов, введённая вручную).
export const AGENT_APPS = ['app', 'opera', 'mozilla', 'edge'];
const LABELS = { app: 'app', opera: 'opera', mozilla: 'mozilla', edge: 'edge' };
export const AGENT_NAME_MAX = 40;
export const AGENT_MAX = 12; // не больше 12 строк
const PATH = 'agent/rows.json';
const ID_RE = /^[a-z0-9]{1,16}$/;
const isMissing = (e) => /not\s*found|404/i.test(String(e && (e.message || e.name)));

export const defaults = () => AGENT_APPS.map((app) => ({ id: app, app, h: null, m: null, at: null }));

const MSK_MS = 3 * 3600e3; // Москва: UTC+3 круглый год (без перехода на летнее время)

// Ближайший момент (мс, UTC), когда в Москве будет h:m. Если это время уже наступило (или наступает сейчас), то завтра.
export function nextAt(h, m, now = Date.now()) {
  const d = new Date(now + MSK_MS);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m) - MSK_MS;
  return at <= now ? at + 864e5 : at;
}

// Название приложения: встроенный id (в том числе если введено как «Opera») или своё название без спецсимволов.
export function cleanApp(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t || t.length > AGENT_NAME_MAX || /[<>"'`&\\\u0000-\u001f]/.test(t)) return null;
  return LABELS[t.toLowerCase()] || t;
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

// Проставляет `at`: прежний, если ч:мин у строки не менялись, иначе новый; без ч:мин — null.
export function withAt(rows, prev, now = Date.now()) {
  const old = new Map(prev.map((r) => [r.id, r]));
  return rows.map((r) => {
    if (r.h === null || r.m === null) return { ...r, at: null };
    const o = old.get(r.id);
    return { ...r, at: o && o.h === r.h && o.m === r.m && o.at ? o.at : nextAt(r.h, r.m, now) };
  });
}

async function readRows() {
  try {
    const r = await get(PATH, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return defaults();
    const raw = JSON.parse(await new Response(r.stream).text());
    return Array.isArray(raw && raw.rows) ? cleanRows(raw.rows, true).slice(0, AGENT_MAX) : defaults();
  } catch (e) {
    if (isMissing(e)) return defaults();
    throw e;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'PUT') return res.status(405).end();
  if (!session(req)) return res.status(401).json({ error: 'auth' });
  const c = renewCookie(req);
  if (c) res.setHeader('Set-Cookie', c);
  try {
    if (req.method === 'GET') return res.status(200).json({ rows: await readRows() });
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    if (!b || !Array.isArray(b.rows)) return res.status(400).json({ error: 'bad request' });
    if (b.rows.length > AGENT_MAX) return res.status(400).json({ error: 'limit' });
    const rows = withAt(cleanRows(b.rows), await readRows());
    await put(PATH, JSON.stringify({ rows }), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
    return res.status(200).json({ rows });
  } catch (e) {
    console.error('agent failed:', e.message);
    return res.status(500).json({ error: 'server' });
  }
}
