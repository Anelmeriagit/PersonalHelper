// Вход только через Google (пароля, никнейма и регистрации нет).
// POST /api/auth  { action: 'logout' }
//   с сессией (этап 5): { action: 'me' } → {id, name, email, tg, partner}; { action: 'rename', name } → {name}; { action: 'delete', confirm: 'удалить' } → {ok}
//   соединение двух аккаунтов: { action: 'pair-link' } → {token, ttl} (одноразовая ссылка, 409 если связь уже есть);
//   { action: 'pair-join', token } → {partner:{name}} (соединить с тем, кто дал ссылку); { action: 'pair-drop' } → {partner:{linked:false}} (разорвать, идемпотентно)
// Вход через Google (этап 5, часть 3), обычные переходы браузера, не fetch:
//   GET /api/auth?action=google     → 302 на Google (код авторизации, state, nonce и PKCE S256; их хранит подписанная cookie cb_oauth, 10 минут)
//   GET /api/auth?action=google-cb  → обмен кода на сервере, проверка id_token, найти или создать аккаунт по sub, cookie cb_session, 302 на /
//   при любом исходе, кроме успеха, 302 на /?gerr=<код>: off | denied | state | rate | full | fail (js/main.js показывает текст по коду)
// Заменяет login.js и logout.js (одна функция вместо двух: лимит 12 функций на Hobby).
import crypto from 'node:crypto';
import { makeCookie, clearCookie, session } from './_lib.js';
import { dbReady, key, hit } from './_db.js';
import { googleAccount, getAcc, getLink, setName, deleteAccount, partnerAcc, createPairToken, joinPair, unpair } from './_acc.js';

const clientIp = (req) => String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '?';
const h = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
const maxUsers = () => Number(process.env.MAX_USERS) || 500;

/* ---------- вход через Google ---------- */
const G_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const G_TOKEN = 'https://oauth2.googleapis.com/token';
const G_ISS = ['https://accounts.google.com', 'accounts.google.com'];
const OAUTH = 'cb_oauth';
const OAUTH_FLAGS = '; HttpOnly; Secure; SameSite=Lax; Path=/api/auth'; // Lax: возврат от Google — переход с другого сайта, Strict такую cookie не отправил бы
const G_WIN = 60 * 60 * 1000, G_IP_MAX = 20;
const b64u = (n) => crypto.randomBytes(n).toString('base64url');
const gConf = () => ({ id: String(process.env.GOOGLE_CLIENT_ID || ''), secret: String(process.env.GOOGLE_CLIENT_SECRET || '') });
const gReady = () => { const c = gConf(); return !!(c.id && c.secret) && String(process.env.SESSION_SECRET || '').length >= 32; };
// Подпись отдельная от сессии (префикс), чтобы одно значение нельзя было выдать за другое.
const oSign = (p) => crypto.createHmac('sha256', String(process.env.SESSION_SECRET || '')).update('google-oauth:' + p).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function queryOf(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  const o = {};
  try { for (const [k, v] of new URL(req.url || '', 'http://x').searchParams) if (!(k in o)) o[k] = v; } catch { /* пусто */ }
  return o;
}
const qs = (v) => (typeof v === 'string' ? v : '');
// Адрес обратного вызова строится от хоста запроса: начало и конец входа идут на одном хосте (cookie привязана к нему),
// а Google принимает только адрес, внесённый в консоль; чужой хост он отклонит.
function callbackUrl(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) return '';
  return (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http://' : 'https://') + host + '/api/auth?action=google-cb';
}
function back(res, code, extra) {
  if (extra) res.setHeader('Set-Cookie', extra);
  res.setHeader('Location', code ? '/?gerr=' + code : '/');
  return res.status(302).end();
}

function googleStart(req, res) {
  const redirect = callbackUrl(req);
  if (!gReady() || !redirect) return back(res, 'off');
  const st = { s: b64u(16), v: b64u(32), n: b64u(16), e: Date.now() + 10 * 60 * 1000 };
  const p = Buffer.from(JSON.stringify(st)).toString('base64url');
  const u = new URLSearchParams({
    client_id: gConf().id, redirect_uri: redirect, response_type: 'code', scope: 'openid email',
    state: st.s, nonce: st.n, code_challenge: crypto.createHash('sha256').update(st.v).digest('base64url'), code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  res.setHeader('Set-Cookie', `${OAUTH}=${p}.${oSign(p)}${OAUTH_FLAGS}; Max-Age=600`);
  res.setHeader('Location', G_AUTH + '?' + u);
  return res.status(302).end();
}

function readOauth(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${OAUTH}=([^;]+)`));
  if (!m) return null;
  const [p, s] = m[1].split('.');
  if (!p || !s || !safeEq(s, oSign(p))) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d && d.e > Date.now() && typeof d.s === 'string' && typeof d.v === 'string' && typeof d.n === 'string' ? d : null;
  } catch { return null; }
}

// id_token пришёл прямо с токен-эндпоинта Google по TLS (OpenID Connect Core 3.1.3.7): подпись не проверяем, проверяем содержимое.
function idClaims(idToken, nonce) {
  const part = String(idToken || '').split('.')[1];
  if (!part) return null;
  let c; try { c = JSON.parse(Buffer.from(part, 'base64url').toString()); } catch { return null; }
  if (!c || typeof c !== 'object') return null;
  if (!G_ISS.includes(c.iss) || c.aud !== gConf().id || !(Number(c.exp) * 1000 > Date.now()) || typeof c.nonce !== 'string' || !safeEq(c.nonce, nonce)) return null;
  if (typeof c.sub !== 'string' || !c.sub) return null;
  return c;
}

async function googleCb(req, res) {
  const q = queryOf(req);
  const clear = `${OAUTH}=${OAUTH_FLAGS}; Max-Age=0`;
  const st = readOauth(req);
  // cookie одноразовая: после любого ответа сбрасываем
  if (!st || !qs(q.state) || qs(q.state).length > 128 || !safeEq(qs(q.state), st.s)) return back(res, 'state', clear);
  if (qs(q.error)) return back(res, qs(q.error) === 'access_denied' ? 'denied' : 'fail', clear);
  const code = qs(q.code);
  const redirect = callbackUrl(req);
  if (!code || code.length > 2048 || !gReady() || !redirect || !dbReady()) return back(res, !gReady() ? 'off' : 'fail', clear);
  try {
    if (await hit(key('rl', 'g', 'ip', h(clientIp(req))), G_WIN) > G_IP_MAX) return back(res, 'rate', clear);
    const r = await globalThis.fetch(G_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: gConf().id, client_secret: gConf().secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: st.v }),
      signal: AbortSignal.timeout(8000),
    });
    let j = null; try { j = await r.json(); } catch { /* тело не JSON */ }
    if (!r.ok || !j || typeof j.id_token !== 'string') {
      console.error('auth google: токен не получен, HTTP', r.status, j && /^[a-z_]{1,40}$/.test(String(j.error)) ? j.error : '');
      return back(res, 'fail', clear);
    }
    const c = idClaims(j.id_token, st.n);
    if (!c) { console.error('auth google: id_token не прошёл проверку'); return back(res, 'fail', clear); }
    const a = await googleAccount(c.sub, c.email_verified === true || c.email_verified === 'true' ? c.email : '', maxUsers());
    if (a.error === 'full') return back(res, 'full', clear);
    return back(res, '', [makeCookie(a.id), clear]);
  } catch (e) {
    console.error('auth google', e && e.name, e && e.message);
    return back(res, 'fail', clear);
  }
}

const DEL_WORD = 'удалить';
const PAIR_WIN = 10 * 60 * 1000, PAIR_LINK_MAX = 5, PAIR_JOIN_MAX = 10; // новых ссылок и попыток соединения на аккаунт за 10 минут
const PAIR_MSG = {
  bad: 'Ссылка недействительна или устарела. Попросите новую.',
  self: 'Нельзя соединить аккаунт с самим собой.',
  mine: 'Ваш аккаунт уже соединён с другим. Сначала разорвите связь в настройках.',
  busy: 'Аккаунт, давший ссылку, уже соединён с другим.',
};
const PAIR_CODE = { bad: 404, self: 400, mine: 409, busy: 409 };

// Партнёр для ответа: { linked: true, name } | { linked: false }. Имя пустое, пока не задано (сайт подставляет «Helper User»).
async function partnerInfo(id) {
  const r = await partnerAcc(id);
  return r ? { linked: true, name: r.acc.name || '' } : { linked: false };
}

// Действия с сессией: id аккаунта берётся только из cookie, не из тела запроса.
async function mine(req, res, body) {
  const id = session(req);
  const acc = id ? await getAcc(id) : null;
  if (!acc) return res.status(401).json({ error: 'auth' });
  if (body.action === 'me') {
    const l = await getLink(id);
    return res.status(200).json({
      id, name: acc.name || '', email: acc.email || '',
      tg: l ? { linked: true, id: String(l.tid), username: l.un || '' } : { linked: false },
      partner: await partnerInfo(id),
    });
  }
  if (body.action === 'pair-link') {
    if (await hit(key('rl', 'pl', id), PAIR_WIN) > PAIR_LINK_MAX) return res.status(429).json({ error: 'Слишком часто. Подождите несколько минут.' });
    const r = await createPairToken(id);
    if (r.error) return res.status(409).json({ error: 'Аккаунт уже соединён. Сначала разорвите связь.', code: 'paired' });
    return res.status(200).json({ token: r.token, ttl: r.ttl });
  }
  if (body.action === 'pair-join') {
    if (await hit(key('rl', 'pj', id), PAIR_WIN) > PAIR_JOIN_MAX) return res.status(429).json({ error: 'Слишком часто. Подождите несколько минут.' });
    const r = await joinPair(typeof body.token === 'string' ? body.token : '', id);
    if (r.error) return res.status(PAIR_CODE[r.error] || 400).json({ error: PAIR_MSG[r.error] || PAIR_MSG.bad, code: r.error });
    return res.status(200).json({ partner: { linked: true, name: r.name } });
  }
  if (body.action === 'pair-drop') {
    await unpair(id);
    return res.status(200).json({ partner: { linked: false } });
  }
  if (body.action === 'rename') {
    if (typeof body.name !== 'string') return res.status(400).json({ error: 'Имя должно быть строкой' });
    const name = await setName(id, body.name);
    if (name === null) return res.status(401).json({ error: 'auth' });
    return res.status(200).json({ name });
  }
  if (String(body.confirm == null ? '' : body.confirm).trim().toLowerCase() !== DEL_WORD) {
    return res.status(400).json({ error: `Для удаления введите слово «${DEL_WORD}»` });
  }
  await deleteAccount(id);
  res.setHeader('Set-Cookie', clearCookie);
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const a = qs(queryOf(req).action);
    if (a === 'google') return googleStart(req, res);
    if (a === 'google-cb') return googleCb(req, res);
  }
  if (req.method !== 'POST') return res.status(405).end();
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  if (body.action === 'logout') {
    res.setHeader('Set-Cookie', clearCookie);
    return res.status(200).json({ ok: true });
  }
  if (!['me', 'rename', 'delete', 'pair-link', 'pair-join', 'pair-drop'].includes(body.action)) return res.status(400).json({ error: 'bad request' });
  if (String(process.env.SESSION_SECRET || '').length < 32 || !dbReady()) {
    console.error('auth: не заданы SESSION_SECRET (≥32 символов) или KV_REST_API_URL / KV_REST_API_TOKEN');
    return res.status(500).json({ error: 'Сервер не настроен' });
  }
  try {
    return await mine(req, res, body);
  } catch (e) {
    console.error('auth', e && e.name, e && e.message);
    return res.status(503).json({ error: 'Сервис временно недоступен. Попробуйте позже.' });
  }
}
