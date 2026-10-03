import { session } from './_lib.js';
import { makeQr } from './_qr.js';

// Экранирование по формату WIFI:... — символы \ ; , : " нужно предварить обратным слэшем.
const esc = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');

export function wifiString({ ssid, password, security, hidden }) {
  const open = security === 'nopass';
  return `WIFI:T:${security};S:${esc(ssid)};${open ? '' : `P:${esc(password)};`}H:${hidden ? 'true' : 'false'};;`;
}

export function readConfig(env) {
  const ssid = String(env.WIFI_SSID || '');
  const password = String(env.WIFI_PASSWORD || '');
  const sec = String(env.WIFI_SECURITY || 'WPA').trim().toUpperCase();
  const security = sec === 'NOPASS' ? 'nopass' : (sec === 'WEP' ? 'WEP' : 'WPA');
  const hidden = String(env.WIFI_HIDDEN || '').trim().toLowerCase() === 'true';
  if (!ssid || (security !== 'nopass' && !password)) return null;
  return { ssid, password: security === 'nopass' ? '' : password, security, hidden };
}

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();
  if (!session(req)) return res.status(401).json({ error: 'auth' });
  const cfg = readConfig(process.env);
  if (!cfg) return res.status(200).json({ configured: false });
  try {
    const qr = makeQr(wifiString(cfg));
    return res.status(200).json({ configured: true, ssid: cfg.ssid, password: cfg.password, security: cfg.security, hidden: cfg.hidden, qr });
  } catch (e) {
    console.error('wifi qr failed:', e.message); // значения сети и строку подключения не логируем
    return res.status(500).json({ error: 'qr' });
  }
}
