// Аккаунты: один человек на аккаунт. Ключи Redis (с префиксом DB_PREFIX, см. _db.js):
//   nick:<никнейм>  → id          (уникальность никнейма, SET NX)
//   acc:<id>        → JSON {nick, pw:"соль:scrypt", at}
//   users           → счётчик аккаунтов (лимит MAX_USERS)
// Пароль нигде не хранится и не логируется, только scrypt-хэш.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { key, cmd, setNx, del } from './_db.js';

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
