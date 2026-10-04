// Хранилище: Upstash Redis через REST (fetch, без пакетов).
// Ключи получают префикс DB_PREFIX (тест "t:", бой пустой), чтобы тест и бой могли делить одну базу.
// Переменные: KV_REST_API_URL, KV_REST_API_TOKEN (запасные имена UPSTASH_REDIS_REST_URL / _TOKEN), DB_PREFIX.

// fetch захватывается при импорте: тесты подменяют globalThis.fetch (мок Telegram) уже после загрузки модулей,
// а заглушка Redis ставится заранее через tests/register.mjs и должна оставаться в силе.
const doFetch = globalThis.fetch;

const baseUrl = () => String(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
export const dbReady = () => !!(baseUrl() && token());

// "1" → "1:", "t:" → "t:", пусто → без префикса.
export function prefix() {
  let p = String(process.env.DB_PREFIX || '').trim();
  if (p && !p.endsWith(':')) p += ':';
  return p;
}
export const key = (...parts) => prefix() + parts.join(':');

const dbError = (kind, message) => { const e = new Error(message); e.name = 'DbError'; e.kind = kind; return e; };

// В сообщения ошибок токен и адрес не попадают.
async function send(path, body) {
  if (!dbReady()) throw dbError('config', 'Redis не настроен: нужны KV_REST_API_URL и KV_REST_API_TOKEN');
  let r;
  try {
    r = await doFetch(baseUrl() + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) { throw dbError('network', 'Redis недоступен: ' + (e && e.name || 'ошибка сети')); }
  let j = null;
  try { j = await r.json(); } catch { /* тело не JSON */ }
  if (!r.ok) throw dbError('http', 'Redis HTTP ' + r.status + (j && typeof j.error === 'string' ? ': ' + j.error : ''));
  return j;
}

// Одна команда: cmd('GET', ключ) → result.
export async function cmd(...args) {
  const j = await send('', args.map(String));
  if (j && j.error) throw dbError('cmd', String(j.error));
  return j ? j.result : null;
}
// Несколько команд за один запрос: pipe([['GET', a], ['PTTL', a]]) → [result, result].
export async function pipe(cmds) {
  const j = await send('/pipeline', cmds.map((c) => c.map(String)));
  if (!Array.isArray(j)) throw dbError('http', 'Redis: неожиданный ответ pipeline');
  return j.map((x) => { if (x && x.error) throw dbError('cmd', String(x.error)); return x ? x.result : null; });
}

/* ---------- скрипты Lua (атомарность на стороне Redis). Первая строка нужна заглушке в tests/redis.mjs ---------- */
export const CAS = `-- cas
local v = tonumber(redis.call('HGET', KEYS[1], 'v') or '0')
if v ~= tonumber(ARGV[1]) then return -1 end
redis.call('HSET', KEYS[1], 'd', ARGV[2], 'v', v + 1)
return v + 1`;
export const HIT = `-- hit
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;
// Атомарно забрать и удалить значение (одноразовые ссылки): два параллельных запроса не получат его оба.
export const TAKE = `-- take
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v`;

/* ---------- документ: хэш {d: JSON, v: версия}; запись только при совпадении версии ---------- */
// getDoc → { doc: объект | null, v: номер версии (0, если документа нет) }
export async function getDoc(k) {
  const r = await cmd('HMGET', k, 'd', 'v');
  const d = r && r[0];
  if (d == null) return { doc: null, v: 0 };
  return { doc: JSON.parse(d), v: Number(r[1]) || 0 };
}
// putDoc → новая версия или null, если версия в базе уже другая (чужая запись).
export async function putDoc(k, obj, expect) {
  const n = Number(await cmd('EVAL', CAS, 1, k, expect || 0, JSON.stringify(obj)));
  return n >= 0 ? n : null;
}

/* ---------- счётчики с окном (лимиты попыток) ---------- */
export const hit = async (k, windowMs) => Number(await cmd('EVAL', HIT, 1, k, windowMs));
export async function count(k) {
  const [n, t] = await pipe([['GET', k], ['PTTL', k]]);
  return { n: Number(n) || 0, ttl: Math.max(0, Number(t) || 0) };
}

// → значение или null (в Lua отсутствие значения приходит как false, REST отдаёт null).
export const take = async (k) => { const v = await cmd('EVAL', TAKE, 1, k); return v == null || v === false ? null : String(v); };

export const setNx = async (k, v) => (await cmd('SET', k, v, 'NX')) === 'OK';
export const del = (...ks) => cmd('DEL', ...ks);
