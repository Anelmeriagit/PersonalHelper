// Аккаунты: один человек на аккаунт. Ключи Redis (с префиксом DB_PREFIX, см. _db.js):
//   nick:<никнейм>  → id          (уникальность никнейма, SET NX)
//   acc:<id>        → JSON {nick, pw:"соль:scrypt", at}
//   users           → счётчик аккаунтов (лимит MAX_USERS)
// Запись acc:<id> может нести отображаемое имя `name` (этап 5; нет поля = не задано).
// Вход через Google (этап 5, часть 3):
//   gid:<sub>       → id          (аккаунт Google по неизменному идентификатору sub; SET NX)
//   acc:<id>        → JSON {gsub, email?, at} без nick и pw (по паролю такой аккаунт не войдёт); email только подтверждённый Google
// Привязка Telegram (этап 3a):
//   tgt:<хеш токена> → id аккаунта (одноразовая ссылка t.me/<бот>?start=<токен>, живёт LINK_TTL секунд; сам токен не хранится)
//   tgp:<id>         → хеш последней выданной ссылки (новая ссылка гасит прежнюю)
//   tg:<id>          → JSON {tid, chat, un, at}: привязанный Telegram аккаунта
//   tgu:<tid>        → id аккаунта (обратный поиск: один Telegram привязан к одному аккаунту)
//   tgs              → множество id аккаунтов с привязанным Telegram (обход для cron, этап 3b); ведут bindTelegram и unlinkTelegram
// Пароль нигде не хранится и не логируется, только scrypt-хэш.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { key, cmd, setNx, del, take } from './_db.js';

const scrypt = promisify(crypto.scrypt);

export const ID_RE = /^[0-9a-f]{32}$/;
export const NICK_RE = /^[a-z0-9][a-z0-9_.-]{2,23}$/;
export const PASS_MIN = 8;
export const PASS_MAX = 200;
export const normNick = (s) => String(s == null ? '' : s).trim().toLowerCase();

export async function hashPw(pass) {
  const salt = crypto.randomBytes(16);
  const d = await scrypt(String(pass), salt, 64);
  return salt.toString('hex') + ':' + d.toString('hex');
}
export async function checkPw(pass, stored) {
  const [s, hx] = String(stored || ':').split(':');
  if (!s || !hx) return false;
  const calc = await scrypt(String(pass), Buffer.from(s, 'hex'), 64);
  const exp = Buffer.from(hx, 'hex');
  return exp.length === calc.length && crypto.timingSafeEqual(calc, exp);
}
// Для несуществующего никнейма проверка идёт по этому значению: время ответа не выдаёт, есть ли такой аккаунт.
export const DUMMY_PW = '00'.repeat(16) + ':' + '00'.repeat(64);

export async function getAcc(id) {
  if (!ID_RE.test(String(id))) return null;
  const raw = await cmd('GET', key('acc', id));
  if (!raw) return null;
  try { return { id, ...JSON.parse(raw) }; } catch { return null; }
}
export async function nickOf(id) { const a = await getAcc(id); return a ? a.nick : null; }

export async function findByNick(nick) {
  const id = await cmd('GET', key('nick', nick));
  return id ? getAcc(id) : null;
}

// → { id } | { error: 'taken' | 'full' }
export async function createAccount(nick, pass, maxUsers) {
  if (await cmd('EXISTS', key('nick', nick))) return { error: 'taken' };
  const rec = JSON.stringify({ nick, pw: await hashPw(pass), at: Date.now() });
  const n = Number(await cmd('INCR', key('users')));
  const back = () => cmd('DECR', key('users')).catch(() => {});
  if (n > maxUsers) { await back(); return { error: 'full' }; }
  const id = crypto.randomBytes(16).toString('hex');
  try {
    if (!(await setNx(key('acc', id), rec))) throw new Error('id занят');
    // Сначала запись аккаунта, потом никнейм: сбой посередине не оставляет «занятый» никнейм без аккаунта.
    if (!(await setNx(key('nick', nick), id))) { await del(key('acc', id)); await back(); return { error: 'taken' }; }
  } catch (e) { await back(); throw e; }
  return { id };
}

// Аккаунт Google по sub. → { id, created } | { error: 'full' }. Существующий аккаунт возвращается как есть (почту не обновляем:
// запись acc читается и пишется целиком без CAS, лишняя запись при входе рискует затереть параллельную смену имени).
// Параллельные первые входы с одним sub: SET NX на gid:<sub> выигрывает один, проигравший откатывает свою запись и берёт чужой id.
export const SUB_RE = /^[0-9A-Za-z_.:-]{1,255}$/;
export async function googleAccount(sub, email, maxUsers) {
  if (!SUB_RE.test(String(sub))) throw new Error('bad sub');
  const gk = key('gid', sub);
  const live = async (id) => (id && ID_RE.test(String(id)) && (await getAcc(id))) ? String(id) : null;
  const cur = await cmd('GET', gk);
  const had = await live(cur);
  if (had) return { id: had, created: false };
  if (cur) await del(gk); // указатель есть, а аккаунта нет (сбой при удалении или создании): убираем и создаём заново; нет указателя — ничего не удаляем (его мог только что поставить параллельный вход)
  const n = Number(await cmd('INCR', key('users')));
  const back = () => cmd('DECR', key('users')).catch(() => {});
  if (n > maxUsers) { await back(); return { error: 'full' }; }
  const id = crypto.randomBytes(16).toString('hex');
  const rec = { gsub: String(sub), at: Date.now() };
  const em = cleanEmail(email);
  if (em) rec.email = em;
  try {
    if (!(await setNx(key('acc', id), JSON.stringify(rec)))) throw new Error('id занят');
    if (!(await setNx(gk, id))) { await del(key('acc', id)); const w = await live(await cmd('GET', gk)); if (w) { await back(); return { id: w, created: false }; } throw new Error('gid занят'); } // throw: счётчик откатит catch
  } catch (e) { await back(); throw e; }
  return { id, created: true };
}
export function cleanEmail(s) {
  const t = String(s == null ? '' : s).trim();
  return t.length <= 254 && /^[^\s@<>"'`&\\\u0000-\u001f]+@[^\s@<>"'`&\\\u0000-\u001f]+$/.test(t) ? t : '';
}

// Отображаемое имя: без управляющих символов, пробелы схлопнуты и обрезаны, не больше NAME_MAX символов (по символам, не по байтам).
export const NAME_MAX = 32;
export function cleanName(s) {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, NAME_MAX).join('').trim();
}
// → отображаемое имя после записи ('' = сброшено) | null, если аккаунта уже нет. SET ... XX: удалённый аккаунт заново не создаётся.
export async function setName(id, name) {
  const acc = await getAcc(id);
  if (!acc) return null;
  const { id: _id, ...rec } = acc;
  const n = cleanName(name);
  if (n) rec.name = n; else delete rec.name;
  return (await cmd('SET', key('acc', id), JSON.stringify(rec), 'XX')) === 'OK' ? n : null;
}

// Полное удаление аккаунта: Telegram, все личные записи, никнейм, счётчик, в конце сама запись acc (пока она есть, повтор после сбоя
// дочистит остальное: сессия остаётся рабочей). → true | false (аккаунта уже нет).
export async function deleteAccount(id) {
  const acc = await getAcc(id);
  if (!acc) return false;
  await unlinkTelegram(id);
  await del(key('doc', id), key('rem', id), key('agent', id), key('wifi', id), key('bot', id), key('rl', 'tgl', id));
  if (acc.nick && (await cmd('GET', key('nick', acc.nick))) === id) await del(key('nick', acc.nick));
  if (acc.gsub && SUB_RE.test(String(acc.gsub)) && (await cmd('GET', key('gid', acc.gsub))) === id) await del(key('gid', acc.gsub));
  if (Number(await del(key('acc', id))) > 0) await cmd('DECR', key('users')).catch(() => {});
  return true;
}

/* ---------- привязка Telegram ---------- */
export const LINK_TTL = 600; // секунд
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/; // 16 случайных байт в base64url; Telegram допускает в start до 64 символов [A-Za-z0-9_-]
const th = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 32);

// Выдаёт новую одноразовую ссылку; прежняя ссылка этого аккаунта перестаёт работать.
export async function createLinkToken(id) {
  const token = crypto.randomBytes(16).toString('base64url');
  const h = th(token);
  const old = await cmd('GET', key('tgp', id));
  await cmd('SET', key('tgt', h), id, 'EX', LINK_TTL);
  await cmd('SET', key('tgp', id), h, 'EX', LINK_TTL);
  if (old && old !== h) await del(key('tgt', old));
  return { token, ttl: LINK_TTL };
}

// → { tid, chat, un, at } | null
export async function getLink(id) {
  if (!ID_RE.test(String(id))) return null;
  const raw = await cmd('GET', key('tg', id));
  if (!raw) return null;
  try { const d = JSON.parse(raw); return d && d.tid ? d : null; } catch { return null; }
}

// Кто пишет боту: id аккаунта по числовому Telegram id или null. Верим только полной паре: tgu:<tid> → id и tg:<id> с тем же tid
// (привязка, прерванная посередине, или перепривязка не дадут чужого доступа). Username не используется: его можно сменить.
export async function accountOfTelegram(tid) {
  if (!/^\d{1,20}$/.test(String(tid))) return null;
  const id = await cmd('GET', key('tgu', String(tid)));
  if (!id || !ID_RE.test(String(id))) return null;
  const l = await getLink(id);
  return l && String(l.tid) === String(tid) ? id : null;
}

// Привязка по токену из /start. from — объект Telegram from, chat — id личного чата.
// → { id, nick } | { error: 'bad' (нет такой ссылки или она устарела) | 'busy' (этот Telegram уже у другого аккаунта) }
// Токен одноразовый: после попытки (даже неудачной по 'busy') нужна новая ссылка.
export async function bindTelegram(token, from, chat) {
  if (!TOKEN_RE.test(String(token)) || !from || !from.id) return { error: 'bad' };
  const id = await take(key('tgt', th(token)));
  if (!id || !ID_RE.test(id)) return { error: 'bad' };
  await del(key('tgp', id));
  const tid = String(from.id);
  const owner = await cmd('GET', key('tgu', tid));
  if (owner && owner !== id) return { error: 'busy' };
  if (!owner && !(await setNx(key('tgu', tid), id))) {
    if ((await cmd('GET', key('tgu', tid))) !== id) return { error: 'busy' };
  }
  const prev = await getLink(id);
  if (prev && String(prev.tid) !== tid) await del(key('tgu', String(prev.tid))); // аккаунт перешёл на другой Telegram
  const un = String(from.username || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
  // Сначала в множество для cron, потом сама привязка: сбой посередине оставит id без tg:<id>, а cron такие пропускает.
  await cmd('SADD', key('tgs'), id);
  await cmd('SET', key('tg', id), JSON.stringify({ tid, chat: String(chat), un, at: Date.now() }));
  return { id, nick: (await nickOf(id)) || '' };
}

// Отвязка: убирает запись аккаунта и обратный поиск (только если он указывает на этот аккаунт). Идемпотентна.
export async function unlinkTelegram(id) {
  await cmd('SREM', key('tgs'), id);
  const l = await getLink(id);
  if (l && (await cmd('GET', key('tgu', String(l.tid)))) === id) await del(key('tgu', String(l.tid)));
  await del(key('tg', id), key('tgp', id));
}

// id всех аккаунтов с привязанным Telegram (для рассылки cron). Каждый id надо ещё проверить через getLink: запись могла пропасть.
export async function linkedIds() {
  const r = await cmd('SMEMBERS', key('tgs'));
  return Array.isArray(r) ? r.filter((x) => ID_RE.test(String(x))).sort() : [];
}
