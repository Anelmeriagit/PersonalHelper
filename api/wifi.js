import crypto from 'node:crypto';
import { session, renewCookie, readRec, writeRec, dropRec, isPrecond } from './_lib.js';
import { makeQr } from './_qr.js';

// Сети пользователя (до 5): Redis, ключ wifi:<id аккаунта> (с префиксом DB_PREFIX), запись { nets: [{id, ssid, password, security, hidden}] }.
// Старая запись одной сети { ssid, ... } читается как список из одной сети (id 'w1') и переписывается при первой правке. Пароль хранится как есть:
// он нужен для показа и QR-кода. Отдаётся только владельцу по сессии, в логи не попадает. Парный файл гостя: js/local.js (менять только вместе).
const KIND = 'wifi';
export const MAX_NETS = 5;
const ID_RE = /^[a-z0-9]{2,12}$/;
const SEC = ['WPA', 'WEP', 'nopass'];
const BAD = /[\u0000-\u001f\u007f]/;
const HEX = /^[0-9a-fA-F]+$/;

// Экранирование по формату WIFI:... — символы \ ; , : " нужно предварить обратным слэшем.
const esc = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');

export function wifiString({ ssid, password, security, hidden }) {
  const open = security === 'nopass';
  return `WIFI:T:${security};S:${esc(ssid)};${open ? '' : `P:${esc(password)};`}H:${hidden ? 'true' : 'false'};;`;
}

// Проверка данных сети. → { cfg } или { error: 'security' | 'ssid' | 'password' }.
// Название — до 32 байт; пароль WPA — 8–63 символа или 64 hex; WEP — 5 или 13 символов либо 10 или 26 hex.
export function cleanWifi(b) {
  const o = b && typeof b === 'object' ? b : {};
  const security = SEC.includes(o.security) ? o.security : null;
  if (!security) return { error: 'security' };
  const ssid = typeof o.ssid === 'string' ? o.ssid : '';
  if (!ssid.trim() || Buffer.byteLength(ssid) > 32 || BAD.test(ssid)) return { error: 'ssid' };
  const hidden = o.hidden === true;
  if (security === 'nopass') return { cfg: { ssid, password: '', security, hidden } };
  const pw = typeof o.password === 'string' ? o.password : '';
  if (BAD.test(pw)) return { error: 'password' };
  const n = pw.length;
  const ok = security === 'WPA' ? (n >= 8 && n <= 63) || (n === 64 && HEX.test(pw)) : n === 5 || n === 13 || ((n === 10 || n === 26) && HEX.test(pw));
  return ok ? { cfg: { ssid, password: pw, security, hidden } } : { error: 'password' };
}

// Список сетей из записи Redis: { nets: [...] } или старый вид одной сети. Негодные сети и лишние сверх MAX_NETS пропускаются; id негодный или повторный заменяется на w1, w2…
export function normNets(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const list = Array.isArray(raw.nets) ? raw.nets : raw.ssid !== undefined ? [{ ...raw, id: 'w1' }] : [];
  const out = [], seen = new Set();
  for (const o of list) {
    if (out.length >= MAX_NETS) break;
    const c = cleanWifi(o);
    if (!c.cfg) continue;
    let id = o && typeof o.id === 'string' && ID_RE.test(o.id) && !seen.has(o.id) ? o.id : null;
    if (!id) { let i = 1; while (seen.has('w' + i)) i++; id = 'w' + i; }
    seen.add(id);
    out.push({ id, ...c.cfg });
  }
  return out;
}
const newId = (nets) => { let id; do { id = crypto.randomBytes(4).toString('hex'); } while (nets.some((n) => n.id === id)); return id; };

// Ответ: { configured, nets: [{id, ssid, password, security, hidden, qr}] }; пока сайт не перешёл на список, поля первой сети дублируются наверху (ssid, password, security, hidden, qr).
function view(nets) {
  if (!nets.length) return { configured: false, nets: [] };
  const list = nets.map((n) => ({ ...n, qr: makeQr(wifiString(n)) }));
  const f = list[0];
  return { configured: true, nets: list, ssid: f.ssid, password: f.password, security: f.security, hidden: f.hidden, qr: f.qr };
}

// Читает список, применяет fn(nets) → { nets } | { code, error } и пишет по версии (CAS). Чужая запись между чтением и записью: повтор, до 4 раз.
async function mutate(user, fn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { raw, etag } = await readRec(KIND, user);
    const nets = normNets(raw);
    const r = fn(nets);
    if (r.error) return r;
    const out = view(r.nets); // строка слишком длинная для QR — ошибка до записи
    if (JSON.stringify(r.nets) === JSON.stringify(nets)) return { out }; // ничего не изменилось: запись не нужна
    if (!r.nets.length) { await dropRec(KIND, user); return { out }; }
    try {
      await writeRec(KIND, user, { nets: r.nets }, etag);
      return { out };
    } catch (e) {
      if (!isPrecond(e)) throw e;
    }
  }
  return { code: 409, error: 'busy' };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'PUT', 'DELETE'].includes(req.method)) return res.status(405).end();
  const user = session(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  const rc = renewCookie(req);
  if (rc) res.setHeader('Set-Cookie', rc);
  try {
    if (req.method === 'GET') {
      const { raw } = await readRec(KIND, user);
      return res.status(200).json(view(normNets(raw)));
    }
    if (req.method === 'DELETE') {
      // ?id=<id сети> удаляет её (нет такой — ничего не меняется); без id удаляется первая сеть (прежний вид запроса)
      const id = String((req.query && req.query.id) || '');
      const r = await mutate(user, (nets) => ({ nets: id ? nets.filter((n) => n.id !== id) : nets.slice(1) }));
      return r.error ? res.status(r.code).json({ error: r.error }) : res.status(200).json(r.out);
    }
    if (!String(req.headers['content-type'] || '').includes('application/json')) return res.status(415).end();
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    const c = cleanWifi(b);
    if (!c.cfg) return res.status(400).json({ error: c.error });
    // Тело: add:true — новая сеть (до MAX_NETS), id — правка этой сети (нет такой: 404 nonet), ни того ни другого (прежний вид) — замена первой сети или создание.
    const add = b.add === true, id = b.id;
    if ((id !== undefined && typeof id !== 'string') || (add && id !== undefined)) return res.status(400).json({ error: 'bad' });
    const r = await mutate(user, (nets) => {
      if (add) return nets.length >= MAX_NETS ? { code: 400, error: 'limit' } : { nets: nets.concat([{ id: newId(nets), ...c.cfg }]) };
      const i = id !== undefined ? nets.findIndex((n) => n.id === id) : 0;
      if (id !== undefined && i < 0) return { code: 404, error: 'nonet' };
      if (!nets.length) return { nets: [{ id: newId(nets), ...c.cfg }] };
      const next = nets.slice();
      next[i] = { id: nets[i].id, ...c.cfg };
      return { nets: next };
    });
    return r.error ? res.status(r.code).json({ error: r.error }) : res.status(200).json(r.out);
  } catch (e) {
    console.error('wifi failed:', e && e.name); // значения сети и строку подключения не логируем
    return res.status(500).json({ error: 'server' });
  }
}
