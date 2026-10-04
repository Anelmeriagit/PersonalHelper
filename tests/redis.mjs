// Заглушка Upstash Redis REST для проверок: хранилище в памяти.
// Подключается через tests/register.mjs: подменяет globalThis.fetch только для адреса KV_REST_API_URL,
// остальные запросы идут в прежний fetch. Код в api/ менять не нужно.
// Поддержано то, что использует код проекта: GET, SET (NX, EX, PX), DEL, EXISTS, INCR, DECR, EXPIRE, PEXPIRE, PTTL,
// HGET, HMGET, HSET и три скрипта EVAL (по первой строке «-- cas», «-- hit» и «-- take», см. api/_db.js).
// Сами Lua-скрипты здесь НЕ исполняются: заглушка повторяет их смысл на JS. Реальный Redis проверяется отдельно (notes/CHECKLIST.md).
process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || 'https://redis.test';
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || 'test-redis-token';

const GOOD_TOKEN = process.env.KV_REST_API_TOKEN; // токен, который «знает» заглушка; отличающийся в окружении кода отвергается

const store = new Map(); // ключ -> { t: 's' | 'h', v, exp: мс | null }
let failMode = null;     // null | 'network' | 'http'
let calls = 0;

export function __reset() { store.clear(); failMode = null; calls = 0; }
export function __fail(mode) { failMode = mode || null; }
export function __keys() { return [...store.keys()].sort(); }
export function __calls() { return calls; }
export function __raw(k) { const e = store.get(k); return e ? (e.t === 'h' ? Object.fromEntries(e.v) : e.v) : undefined; }

const rerr = (msg) => { const e = new Error(msg); e.redis = true; return e; };
const live = (k) => {
  const e = store.get(k);
  if (!e) return null;
  if (e.exp !== null && e.exp <= Date.now()) { store.delete(k); return null; }
  return e;
};
const str = (k) => {
  const e = live(k);
  if (!e) return null;
  if (e.t !== 's') throw rerr('WRONGTYPE Operation against a key holding the wrong kind of value');
  return e;
};
const hash = (k, create) => {
  let e = live(k);
  if (!e && create) { e = { t: 'h', v: new Map(), exp: null }; store.set(k, e); }
  if (e && e.t !== 'h') throw rerr('WRONGTYPE Operation against a key holding the wrong kind of value');
  return e;
};
const int = (s) => { if (!/^-?\d+$/.test(String(s))) throw rerr('ERR value is not an integer or out of range'); return Number(s); };

function evalScript(script, keys, argv) {
  const k = keys[0];
  if (script.startsWith('-- cas')) {
    const e = hash(k, false);
    const v = e && e.v.has('v') ? Number(e.v.get('v')) : 0;
    if (v !== Number(argv[0])) return -1;
    const h = hash(k, true);
    h.v.set('d', argv[1]); h.v.set('v', String(v + 1));
    return v + 1;
  }
  if (script.startsWith('-- hit')) {
    const e = str(k);
    const n = (e ? int(e.v) : 0) + 1;
    store.set(k, { t: 's', v: String(n), exp: e ? e.exp : null });
    if (n === 1) store.get(k).exp = Date.now() + Number(argv[0]);
    return n;
  }
  if (script.startsWith('-- take')) {
    const e = str(k);
    if (!e) return null;
    store.delete(k);
    return e.v;
  }
  throw rerr('ERR заглушка не знает этот скрипт EVAL');
}

function exec(args) {
  const [name, ...a] = args;
  switch (String(name).toUpperCase()) {
    case 'GET': { const e = str(a[0]); return e ? e.v : null; }
    case 'SET': {
      const [k, v, ...o] = a;
      let nx = false, exp = null;
      for (let i = 0; i < o.length; i++) {
        const f = String(o[i]).toUpperCase();
        if (f === 'NX') nx = true;
        else if (f === 'EX') exp = Date.now() + int(o[++i]) * 1000;
        else if (f === 'PX') exp = Date.now() + int(o[++i]);
        else throw rerr('ERR syntax error');
      }
      if (nx && live(k)) return null;
      store.set(k, { t: 's', v: String(v), exp });
      return 'OK';
    }
    case 'DEL': return a.reduce((n, k) => n + (live(k) ? (store.delete(k), 1) : 0), 0);
    case 'EXISTS': return a.reduce((n, k) => n + (live(k) ? 1 : 0), 0);
    case 'INCR': case 'DECR': {
      const e = str(a[0]);
      const n = (e ? int(e.v) : 0) + (String(name).toUpperCase() === 'INCR' ? 1 : -1);
      store.set(a[0], { t: 's', v: String(n), exp: e ? e.exp : null });
      return n;
    }
    case 'EXPIRE': case 'PEXPIRE': {
      const e = live(a[0]);
      if (!e) return 0;
      e.exp = Date.now() + int(a[1]) * (String(name).toUpperCase() === 'EXPIRE' ? 1000 : 1);
      return 1;
    }
    case 'PTTL': { const e = live(a[0]); return !e ? -2 : e.exp === null ? -1 : e.exp - Date.now(); }
    case 'HGET': { const e = hash(a[0], false); return e && e.v.has(a[1]) ? e.v.get(a[1]) : null; }
    case 'HMGET': { const e = hash(a[0], false); return a.slice(1).map((f) => (e && e.v.has(f) ? e.v.get(f) : null)); }
    case 'HSET': {
      const h = hash(a[0], true);
      let added = 0;
      for (let i = 1; i + 1 < a.length; i += 2) { if (!h.v.has(a[i])) added++; h.v.set(a[i], String(a[i + 1])); }
      return added;
    }
    case 'EVAL': { const n = int(a[1]); return evalScript(a[0], a.slice(2, 2 + n), a.slice(2 + n)); }
    default: throw rerr('ERR unknown command ' + name);
  }
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const REAL_FETCH = globalThis.fetch;

globalThis.fetch = async function fetchWithRedis(url, opts = {}) {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const u = String(url);
  if (!base || !u.startsWith(base)) return REAL_FETCH(url, opts);
  calls++;
  if (failMode === 'network') throw new TypeError('fetch failed');
  if (failMode === 'http') return json({ error: 'ERR simulated outage' }, 500);
  const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
  if (auth !== 'Bearer ' + GOOD_TOKEN) return json({ error: 'WRONGPASS invalid or missing auth token' }, 401);
  const path = u.slice(base.length).replace(/\/+$/, '');
  const body = JSON.parse(opts.body);
  const run = (c) => { try { return { result: exec(c) }; } catch (e) { if (e.redis) return { error: e.message }; throw e; } };
  if (path === '') { const r = run(body); return r.error ? json(r, 400) : json(r); }
  if (path === '/pipeline') return json(body.map(run));
  return json({ error: 'ERR неизвестный путь заглушки: ' + path }, 404);
};
