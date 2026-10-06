// Заглушка @vercel/blob для проверок: хранилище в памяти.
// Повторяет то, что нужно коду проекта: get / put / head / del / list (url, limit и cursor), ETag, ifMatch, allowOverwrite. Тела хранятся как Buffer (копии бинарные).
// Подключается через tests/register.mjs, код в api/ менять не нужно.
import { __reset as resetRedis } from './redis.mjs';

const store = new Map();
let seq = 0;
let failPut = false;
let failOn = null; // { match, times }: put с путём, содержащим match, падает times раз
let puts = 0;

// Сброс заодно очищает заглушку Redis: старые тесты вызывают только этот __reset.
export function __reset() { store.clear(); seq = 0; failPut = false; failOn = null; puts = 0; resetRedis(); }
export function __failPutOn(match, times) { failOn = match ? { match, times: times || 1 } : null; } // отказ записи нужного файла
export function __puts() { return puts; }
export function __read(path) { const c = store.get(path); return c ? Buffer.from(c.body) : null; }
export function __write(path, buf) { const c = store.get(path); if (c) store.set(path, { ...c, body: Buffer.from(buf), etag: '"x' + (++seq).toString(16) + '"' }); } // подмена содержимого, как порча в хранилище
export function __failPut(on) { failPut = !!on; } // имитация отказа записи
export function __keys() { return [...store.keys()].sort(); }

const err = (name, message) => { const e = new Error(message); e.name = name; return e; };

export async function put(path, body, opts = {}) {
  if (failPut) throw err('BlobError', 'Vercel Blob: simulated outage');
  if (failOn && path.includes(failOn.match)) { if (--failOn.times <= 0) failOn = null; throw err('BlobError', 'Vercel Blob: simulated outage of ' + 'one file'); }
  puts++;
  const cur = store.get(path);
  if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) throw err('BlobPreconditionFailedError', 'Vercel Blob: Precondition failed: ETag mismatch.');
  if (cur && !opts.allowOverwrite) throw err('BlobError', 'Vercel Blob: This blob already exists, use `allowOverwrite: true` to overwrite it.');
  const etag = '"' + (++seq).toString(16) + '"';
  store.set(path, { body: Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(String(body)), etag, contentType: opts.contentType });
  return { url: 'https://stub.blob/' + path, pathname: path, etag };
}

export async function get(path) {
  const cur = store.get(path);
  if (!cur) return null;
  return { statusCode: 200, stream: new Response(cur.body).body, // Buffer → поток
     blob: { pathname: path, etag: cur.etag } };
}

export async function head(path) {
  const cur = store.get(path);
  if (!cur) throw err('BlobNotFoundError', 'Vercel Blob: The requested blob does not exist');
  return { pathname: path, etag: cur.etag };
}

export async function del(path) { for (const p of [].concat(path)) store.delete(String(p).replace('https://stub.blob/', '')); } // принимает и url, и путь

export async function list(opts = {}) {
  const prefix = opts.prefix || '';
  const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
  const from = opts.cursor ? Number(opts.cursor) : 0, limit = opts.limit || 1000;
  const page = all.slice(from, from + limit);
  const more = from + limit < all.length;
  return { blobs: page.map((pathname) => ({ pathname, url: 'https://stub.blob/' + pathname })), hasMore: more, cursor: more ? String(from + limit) : undefined };
}
