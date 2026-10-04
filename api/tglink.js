// Привязка Telegram к аккаунту (одна функция на три действия: лимит 12 функций на Hobby).
//   GET    → { linked: bool, username?: string }
//   POST   → { url, ttl }: новая одноразовая ссылка https://t.me/<бот>?start=<токен> (прежняя гаснет)
//   DELETE → { linked: false }: отвязать (идемпотентно)
// Саму привязку выполняет api/telegram.js, когда человек нажимает «Запустить» по ссылке.
import { session } from './_lib.js';
import { dbReady, key, hit } from './_db.js';
import { createLinkToken, getLink, unlinkTelegram } from './_acc.js';
import { botUsername } from './_bot.js';

const WIN = 10 * 60 * 1000, MAX = 5; // не больше 5 новых ссылок на аккаунт за 10 минут

async function status(id) {
  const l = await getLink(id);
  return l ? { linked: true, username: l.un || '' } : { linked: false };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const user = session(req);
  if (!user) return res.status(401).json({ error: 'auth' });
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return res.status(405).end();
  if (!dbReady()) return res.status(503).json({ error: 'Сервер не настроен' });
  try {
    if (req.method === 'GET') return res.status(200).json(await status(user));
    if (req.method === 'DELETE') { await unlinkTelegram(user); return res.status(200).json({ linked: false }); }
    if (await hit(key('rl', 'tgl', user), WIN) > MAX) return res.status(429).json({ error: 'Слишком часто. Подождите несколько минут.' });
    const name = await botUsername();
    if (!name) return res.status(503).json({ error: 'Бот сейчас недоступен. Попробуйте позже.' });
    const { token, ttl } = await createLinkToken(user);
    return res.status(200).json({ url: `https://t.me/${name}?start=${token}`, ttl });
  } catch (e) {
    console.error('tglink', e && e.name, e && e.message);
    return res.status(503).json({ error: 'Сервис временно недоступен. Попробуйте позже.' });
  }
}
