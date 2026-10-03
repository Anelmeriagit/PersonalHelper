// Заглушка @vercel/blob для проверок: хранилище в памяти.
// Повторяет то, что нужно коду проекта: get / put / head / del / list, ETag, ifMatch, allowOverwrite.
// Подключается через tests/register.mjs, код в api/ менять не нужно.
import { __reset as resetRedis } from './redis.mjs';

const store = new Map();
let seq = 0;
let failPut = false;

// Сброс заодно очищает заглушку Redis: старые тесты вызывают только этот __reset.
export function __reset() { store.clear(); seq = 0; failPut = false; resetRedis(); }
export function __failPut(on) { failPut = !!on; } // имитация отказа записи
export function __keys() { return [...store.keys()].sort(); }

const err = (name, message) => { const e = new Error(message); e.name = name; return e; };

export async function put(path, body, opts = {}) {
  if (failPut) throw err('BlobError', 'Vercel Blob: simulated outage');
  const cur = store.get(path);
  if (opts.ifMatch && (!cur || cur.etag !== opts.ifMatch)) throw err('BlobPreconditionFailedError', 'Vercel Blob: Precondition failed: ETag mismatch.');
  if (cur && !opts.allowOverwrite) throw err('BlobError', 'Vercel Blob: This blob already exists, use `allowOverwrite: true` to overwrite it.');
  const etag = '"' + (++seq).toString(16) + '"';
  store.set(path, { body: String(body), etag, contentType: opts.contentType });
  return { url: 'https://stub.blob/' + path, pathname: path, etag };
}

export async function get(path) {
  const cur = store.get(path);
  if (!cur) return null;
  return { statusCode: 200, stream: new Response(cur.body).body, blob: { pathname: path, etag: cur.etag } };
}

export async function head(path) {
  const cur = store.get(path);
  if (!cur) throw err('BlobNotFoundError', 'Vercel Blob: The requested blob does not exist');
  return { pathname: path, etag: cur.etag };
}

export async function del(path) { for (const p of [].concat(path)) store.delete(p); }

export async function list(opts = {}) {
  const prefix = opts.prefix || '';
  return { blobs: [...store.keys()].filter((k) => k.startsWith(prefix)).map((pathname) => ({ pathname })), hasMore: false };
}
