// POST /api/auth  { action: 'login' | 'register' | 'logout', user, pass }
//   с сессией (этап 5): { action: 'me' } → {id, name, email, tg}; { action: 'rename', name } → {name}; { action: 'delete', confirm: 'удалить' } → {ok}
// Заменяет login.js и logout.js (одна функция вместо двух: лимит 12 функций на Hobby).
import crypto from 'node:crypto';
import { makeCookie, clearCookie, session } from './_lib.js';
import { dbReady, key, hit, count } from './_db.js';
import { NICK_RE, PASS_MIN, PASS_MAX, normNick, checkPw, findByNick, createAccount, DUMMY_PW, getAcc, getLink, setName, deleteAccount } from './_acc.js';

const WIN = 15 * 60 * 1000;          // окно лимита входа
const LOGIN_IP_MAX = 10;             // неудачных входов с одного адреса за окно
const LOGIN_NICK_MAX = 10;           // неудачных входов на один никнейм за окно (с любых адресов)
const REG_WIN = 60 * 60 * 1000, REG_IP_MAX = 10;

const clientIp = (req) => String(req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '?';
const h = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
const mins = (ms) => Math.max(1, Math.ceil(ms / 60000));
const maxUsers = () => Number(process.env.MAX_USERS) || 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(req, res, body) {
  const nick = normNick(body.user);
  const pass = typeof body.pass === 'string' && body.pass.length <= PASS_MAX ? body.pass : '';
  const ipk = key('rl', 'li', 'ip', h(clientIp(req)));
  const nk = key('rl', 'li', 'nick', h(nick));
  const [a, b] = await Promise.all([count(ipk), count(nk)]);
  const blocked = a.n >= LOGIN_IP_MAX ? a : b.n >= LOGIN_NICK_MAX ? b : null;
  if (blocked) return res.status(429).json({ error: `Слишком много попыток. Подождите ${mins(blocked.ttl)} мин.` });

  const acc = NICK_RE.test(nick) ? await findByNick(nick) : null;
  const ok = await checkPw(pass, acc ? acc.pw : DUMMY_PW); // scrypt считается и для чужого никнейма
  if (ok && acc) {
    res.setHeader('Set-Cookie', makeCookie(acc.id));
    return res.status(200).json({ ok: true });
  }
  await Promise.all([hit(ipk, WIN), hit(nk, WIN)]);
  await sleep(700);
  return res.status(401).json({ error: 'Неверный никнейм или пароль' });
}

async function register(req, res, body) {
  if (process.env.REG_OPEN !== '1') return res.status(403).json({ error: 'Регистрация сейчас закрыта' });
  const nick = normNick(body.user);
  const pass = typeof body.pass === 'string' ? body.pass : '';
  if (!NICK_RE.test(nick)) return res.status(400).json({ error: 'Никнейм: 3–24 символа, латинские буквы, цифры, _ . -' });
  if (pass.length < PASS_MIN || pass.length > PASS_MAX) return res.status(400).json({ error: `Пароль: от ${PASS_MIN} символов` });
  if (await hit(key('rl', 'reg', 'ip', h(clientIp(req))), REG_WIN) > REG_IP_MAX) {
    return res.status(429).json({ error: 'Слишком много регистраций с этого адреса. Попробуйте позже.' });
  }
  const r = await createAccount(nick, pass, maxUsers());
  if (r.error === 'taken') return res.status(409).json({ error: 'Этот никнейм уже занят' });
  if (r.error === 'full') return res.status(403).json({ error: 'Достигнут лимит пользователей' });
  res.setHeader('Set-Cookie', makeCookie(r.id));
  return res.status(200).json({ ok: true });
}

const DEL_WORD = 'удалить';

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
    });
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
  if (req.method !== 'POST') return res.status(405).end();
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body && typeof body === 'object' ? body : {};

  if (body.action === 'logout') {
    res.setHeader('Set-Cookie', clearCookie);
    return res.status(200).json({ ok: true });
  }
  if (!['login', 'register', 'me', 'rename', 'delete'].includes(body.action)) return res.status(400).json({ error: 'bad request' });
  if (String(process.env.SESSION_SECRET || '').length < 32 || !dbReady()) {
    console.error('auth: не заданы SESSION_SECRET (≥32 символов) или KV_REST_API_URL / KV_REST_API_TOKEN');
    return res.status(500).json({ error: 'Сервер не настроен' });
  }
  try {
    return await (body.action === 'login' ? login : body.action === 'register' ? register : mine)(req, res, body);
  } catch (e) {
    console.error('auth', e && e.name, e && e.message);
    return res.status(503).json({ error: 'Сервис временно недоступен. Попробуйте позже.' });
  }
}
