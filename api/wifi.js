import crypto from 'node:crypto';
import { session, renewCookie, readRec, writeRec, dropRec, isPrecond } from './_lib.js';
import { makeQr } from './_qr.js';
import { partnerAcc, pairId } from './_acc.js';

// Сети пользователя (до 5): Redis, ключ wifi:<id аккаунта> (с префиксом DB_PREFIX), запись { nets: [{id, ssid, password, security, hidden}] }.
// Старая запись одной сети { ssid, ... } читается как список из одной сети (id 'w1') и переписывается при первой правке. Пароль хранится как есть:
// он нужен для показа и QR-кода. Отдаётся только владельцу по сессии, в логи не попадает. Парный файл гостя: js/local.js (менять только вместе).
// У соединённых аккаунтов список общий: запись wfs:<меньший id>:<больший id> (по образцу shr:), { nets } или, пока выбор при соединении не сделан,
// { nets: [], pend: true } (тогда каждый работает со своей личной записью wifi:<id>). Читается только после partnerAcc (partnerAcc → pairId).
// При разрыве связи общий список копируется в личные записи обоих (unpair в _acc.js).
const KIND = 'wifi';
const SKIND = 'wfs';
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

// Ответ: { configured, nets: [{id, ssid, password, security, hidden, qr}] }
function view(nets) {
  if (!nets.length) return { configured: false, nets: [] };
  return { configured: true, nets: nets.map((n) => ({ ...n, qr: makeQr(wifiString(n)) })) };
}

// Читает список (запись kind:id), применяет fn(nets) → { nets } | { code, error } и пишет по версии (CAS). Чужая запись между чтением и записью: повтор, до 4 раз.
// shared — общий список пары: запись должна существовать (иначе связь разорвали, 409 busy) и при пустом списке остаётся как { nets: [] }.
async function mutate(kind, user, fn, shared) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { raw, etag } = await readRec(kind, user);
    if (shared && (!raw || raw.pend)) return { code: 409, error: 'busy' };
    const nets = normNets(raw);
    const r = fn(nets);
    if (r.error) return r;
    const out = view(r.nets); // строка слишком длинная для QR — ошибка до записи
    if (JSON.stringify(r.nets) === JSON.stringify(nets)) return { out }; // ничего не изменилось: запись не нужна
    if (!r.nets.length && !shared) { await dropRec(kind, user); return { out }; }
    try {
      await writeRec(kind, user, { nets: r.nets }, etag);
      return { out };
    } catch (e) {
      if (!isPrecond(e)) throw e;
    }
  }
  return { code: 409, error: 'busy' };
}

/* ---------- общий список пары ---------- */
const sameNet = (a, b) => a.security === b.security && a.ssid === b.ssid && (a.security === 'nopass' || a.password === b.password);
const has = (list, n) => list.some((x) => sameNet(x, n));
// Объединение: сначала a, затем сети b, которых в a нет; повторные id заменяются (normNets).
const union = (a, b) => normNets({ nets: a.concat(b.filter((n) => !has(a, n))) });
const brief = (nets) => nets.map((n) => ({ ssid: n.ssid, security: n.security, hidden: n.hidden }));

// Общая запись пары: есть → вернуть; нет (новая связь или пара до этой правки) → создать из личных списков обоих (запись только если её нет, CAS).
// Если у каждого есть сеть, которой нет у другого, выбор за людьми: { nets: [], pend: true }, личные списки не меняются; иначе список — объединение.
async function ensureShared(a, b) {
  const k = pairId(a, b);
  for (let i = 0; i < 3; i++) {
    const cur = await readRec(SKIND, k);
    if (cur.raw) return { k, raw: cur.raw, etag: cur.etag };
    const [ra, rb] = await Promise.all([readRec(KIND, a), readRec(KIND, b)]);
    const na = normNets(ra.raw), nb = normNets(rb.raw);
    const rec = na.some((n) => !has(nb, n)) && nb.some((n) => !has(na, n)) ? { nets: [], pend: true } : { nets: union(na, nb) };
    try {
      const w = await writeRec(SKIND, k, rec, null);
      return { k, raw: rec, etag: w.etag };
    } catch (e) {
      if (!isPrecond(e)) throw e;
    }
  }
  throw new Error('shared wifi busy');
}

// Контекст общего списка: у соединённых аккаунтов { k, raw, etag, pid }, если выбор сделан; иначе null (личная запись: нет связи или выбор ещё не сделан).
async function sharedCtx(user) {
  const pa = await partnerAcc(user);
  if (!pa) return null;
  const s = await ensureShared(user, pa.id);
  return s.raw.pend ? null : { ...s, pid: pa.id };
}

// Выбор при соединении, если у двоих разные сети. choice: 'mine' | 'partner' | 'both' (мои сети — того, кто спрашивает). Без choice только состояние.
// → { pending: false } | { pending: true, mine, partner, both } (названия без паролей, both — сколько сетей будет в общем списке при «обе») | { error: 'nopair' | 'bad' | 'limit' | 'busy' }
// known — id партнёра, если пару только что проверил joinPair (pair-join): повторно её не читаем.
export async function wifiChoice(user, choice, known) {
  if (choice !== undefined && !['mine', 'partner', 'both'].includes(choice)) return { error: 'bad' };
  const pa = known ? { id: known } : await partnerAcc(user);
  if (!pa) return { error: 'nopair' };
  for (let i = 0; i < 3; i++) {
    const s = await ensureShared(user, pa.id);
    if (!s.raw.pend) return { pending: false };
    const [ra, rb] = await Promise.all([readRec(KIND, user), readRec(KIND, pa.id)]);
    const mine = normNets(ra.raw), partner = normNets(rb.raw);
    const total = mine.length + partner.filter((n) => !has(mine, n)).length; // сетей при «обе» (union режет до MAX_NETS)
    if (choice === undefined) return { pending: true, mine: brief(mine), partner: brief(partner), both: total };
    if (choice === 'both' && total > MAX_NETS) return { error: 'limit' };
    const nets = choice === 'mine' ? mine : choice === 'partner' ? partner : union(mine, partner);
    try {
      await writeRec(SKIND, s.k, { nets }, s.etag);
      return { pending: false };
    } catch (e) {
      if (!isPrecond(e)) throw e;
    }
  }
  return { error: 'busy' };
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
      const sh = await sharedCtx(user); // у соединённых аккаунтов список общий
      const { raw } = sh ? { raw: sh.raw } : await readRec(KIND, user);
      return res.status(200).json(view(normNets(raw)));
    }
    if (req.method === 'DELETE') {
      // ?id=<id сети> удаляет её (нет такой — ничего не меняется); без id удаляется первая сеть (прежний вид запроса)
      const id = String((req.query && req.query.id) || '');
      const sh = await sharedCtx(user);
      const r = await mutate(sh ? SKIND : KIND, sh ? sh.k : user, (nets) => ({ nets: id ? nets.filter((n) => n.id !== id) : nets.slice(1) }), !!sh);
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
    const sh = await sharedCtx(user);
    const r = await mutate(sh ? SKIND : KIND, sh ? sh.k : user, (nets) => {
      if (add) return nets.length >= MAX_NETS ? { code: 400, error: 'limit' } : { nets: nets.concat([{ id: newId(nets), ...c.cfg }]) };
      const i = id !== undefined ? nets.findIndex((n) => n.id === id) : 0;
      if (id !== undefined && i < 0) return { code: 404, error: 'nonet' };
      if (!nets.length) return { nets: [{ id: newId(nets), ...c.cfg }] };
      const next = nets.slice();
      next[i] = { id: nets[i].id, ...c.cfg };
      return { nets: next };
    }, !!sh);
    return r.error ? res.status(r.code).json({ error: r.error }) : res.status(200).json(r.out);
  } catch (e) {
    console.error('wifi failed:', e && e.name); // значения сети и строку подключения не логируем
    return res.status(500).json({ error: 'server' });
  }
}
