import { session, renewCookie, readRec, writeRec, dropRec, isPrecond } from './_lib.js';
import { makeQr } from './_qr.js';

// Личная сеть пользователя: Redis, ключ wifi:<id аккаунта> (с префиксом DB_PREFIX). Пароль хранится как есть:
// он нужен для показа и QR-кода. Отдаётся только владельцу по сессии, в логи не попадает.
const KIND = 'wifi';
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

function view(cfg) {
  if (!cfg) return { configured: false };
  return { configured: true, ssid: cfg.ssid, password: cfg.password, security: cfg.security, hidden: cfg.hidden, qr: makeQr(wifiString(cfg)) };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'PUT', 'DELETE'].includes(req.method)) return res.status(405).end();
  const user = session(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  const rc = renewCookie(req);
  if (rc) res.setHeader('Set-Cookie', rc);
  try {
    if (req.method === 'DELETE') { await dropRec(KIND, user); return res.status(200).json({ configured: false }); }
    if (req.method === 'GET') {
      const { raw } = await readRec(KIND, user);
      const c = raw ? cleanWifi(raw) : null;
      return res.status(200).json(view(c && c.cfg));
    }
    if (!String(req.headers['content-type'] || '').includes('application/json')) return res.status(415).end();
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    const c = cleanWifi(b);
    if (!c.cfg) return res.status(400).json({ error: c.error });
    const qr = view(c.cfg); // строка слишком длинная для QR — ошибка до записи
    // Одна запись на пользователя, последняя побеждает; проверка версии нужна только чтобы не затереть запись, пришедшую между чтением и записью.
    for (let attempt = 0; attempt < 4; attempt++) {
      const { etag } = await readRec(KIND, user);
      try {
        await writeRec(KIND, user, c.cfg, etag);
        return res.status(200).json(qr);
      } catch (e) {
        if (!isPrecond(e)) throw e;
      }
    }
    return res.status(409).json({ error: 'busy' });
  } catch (e) {
    console.error('wifi failed:', e && e.name); // значения сети и строку подключения не логируем
    return res.status(500).json({ error: 'server' });
  }
}
