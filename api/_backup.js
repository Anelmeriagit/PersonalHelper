// Резервная копия Redis. Ядро (4.1): чтение ключей, формат записей, шифрование. Хранение в Blob (4.2): части, манифест, курсор, 7 копий.
// Запуск из cron (4.3) и восстановление (4.4) строятся на этих функциях. Единственное место в api/, где используется Blob (приватный, всё зашифровано).
// Переменная: BACKUP_KEY — 64 шестнадцатеричных символа (32 байта). Значение нигде не хранится и не логируется.
//
// Что копируется: все ключи с префиксом DB_PREFIX (в бою пустой). Типы string, hash и set: другие типы код проекта не использует,
// их копия пропускает и считает в stats.other. Оставшееся время жизни ключа (PTTL) сохраняется.
// В записях ключ хранится БЕЗ префикса: копию боевой базы можно проверить в тестовом префиксе («t:»), см. restoreCmds.
// При пустом префиксе пропускаются чужие ключи тестового проекта (SKIP_PREFIXES), иначе они попали бы в боевую копию.
//
// Часть копии (одна «страница» файла в Blob) = sealed(gzip(строка-заголовок + по записи на строку)):
//   байты: «PHB1» (4) | id ключа (4) | iv (12) | тег GCM (16) | шифртекст.
//   Заголовок и id ключа входят в AAD вместе со snap и n: часть нельзя незаметно подменить или переставить в другой копии.
// Запись: {k, t:'s', v:'строка'} | {k, t:'h', v:[[поле, значение], ...]} | {k, t:'e', v:[члены]}, плюс ttl (мс, целое > 0), если он есть.
// Хэш хранится парами, а не объектом: поле «__proto__» не должно ничего менять в прототипе.
// SCAN не атомарен: ключ, записанный во время обхода, может попасть в копию в старой или новой версии; повторы ключей возможны
// (при восстановлении побеждает последняя запись). Документы версионируются (CAS), поэтому копия ключа сама по себе целостна.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { cmd, pipe, prefix, dbReady } from './_db.js';

export const FORMAT = 1;
export const SKIP_PREFIXES = ['t:', 'selftest'];
export const MAX_PLAIN = 64 * 1024 * 1024; // предел распакованной части: защита от «бомбы» при восстановлении
const MAGIC = Buffer.from('PHB1');
const KID_LEN = 4, IV_LEN = 12, TAG_LEN = 16;
const SNAP_RE = /^[0-9a-z][0-9a-z-]{3,39}$/;

function berr(kind, message) { const e = new Error(message); e.name = 'BackupError'; e.kind = kind; return e; }
export const globEsc = (s) => String(s).replace(/[\\*?[\]]/g, '\\$&');
export function normPrefix(p) { p = String(p || '').trim(); return p && !p.endsWith(':') ? p + ':' : p; }

/* ---------- ключ шифрования ---------- */
const KEY_RE = /^[0-9a-fA-F]{64}$/;
export function backupReady() { const s = String(process.env.BACKUP_KEY || '').trim(); return KEY_RE.test(s) && new Set(s.toLowerCase()).size >= 8; }
export function backupKey() {
  const s = String(process.env.BACKUP_KEY || '').trim();
  if (!KEY_RE.test(s)) throw berr('config', 'BACKUP_KEY: нужна строка из 64 шестнадцатеричных символов (32 байта)');
  if (new Set(s.toLowerCase()).size < 8) throw berr('config', 'BACKUP_KEY слишком простой: сгенерируйте случайный');
  return Buffer.from(s, 'hex');
}
// Короткий отпечаток ключа (4 байта sha256): по нему при восстановлении отличают «не тот ключ» от «файл испорчен».
const kidOf = (key) => createHash('sha256').update(key).digest().subarray(0, KID_LEN);

/* ---------- шифрование ---------- */
export function seal(plain, aad) {
  const key = backupKey();
  const kid = kidOf(key), iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.concat([MAGIC, kid, Buffer.from(String(aad))]));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, kid, iv, c.getAuthTag(), ct]);
}
// kind ошибки: 'format' (не наш файл или обрезан), 'key' (другой BACKUP_KEY), 'tamper' (изменён, повреждён или не та часть)
export function open(buf, aad) {
  const key = backupKey();
  const head = MAGIC.length + KID_LEN + IV_LEN + TAG_LEN;
  if (!Buffer.isBuffer(buf) || buf.length < head || !buf.subarray(0, 4).equals(MAGIC)) throw berr('format', 'Это не файл копии или он обрезан');
  const kid = buf.subarray(4, 4 + KID_LEN);
  if (!kid.equals(kidOf(key))) throw berr('key', 'Копия зашифрована другим BACKUP_KEY');
  const iv = buf.subarray(8, 8 + IV_LEN), tag = buf.subarray(8 + IV_LEN, head);
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(Buffer.concat([MAGIC, kid, Buffer.from(String(aad))]));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(buf.subarray(head)), d.final()]);
  } catch { throw berr('tamper', 'Копия повреждена, подменена или это другая часть'); }
}

/* ---------- записи ---------- */
const isStr = (x) => typeof x === 'string';
export function validRec(r) {
  if (!r || typeof r !== 'object' || !isStr(r.k) || !r.k || r.k.length > 512) return false;
  if (r.ttl !== undefined && !(Number.isInteger(r.ttl) && r.ttl > 0)) return false;
  if (r.t === 's') return isStr(r.v);
  if (r.t === 'h') return Array.isArray(r.v) && r.v.length > 0 && r.v.every((p) => Array.isArray(p) && p.length === 2 && isStr(p[0]) && isStr(p[1]));
  if (r.t === 'e') return Array.isArray(r.v) && r.v.length > 0 && r.v.every(isStr);
  return false;
}
// Размер записи в байтах (для деления на части в 4.2).
export const recSize = (r) => Buffer.byteLength(JSON.stringify(r)) + 1;

// Команды, возвращающие ключ в базу: DEL (стереть прежнее, в том числе другого типа), запись, при необходимости срок жизни.
// to — префикс назначения (по умолчанию текущий DB_PREFIX): так копию боевой базы проверяют в «t:».
export function restoreCmds(r, to) {
  if (!validRec(r)) throw berr('format', 'Запись копии повреждена');
  const k = (to === undefined ? prefix() : normPrefix(to)) + r.k;
  const out = [['DEL', k]];
  if (r.t === 's') out.push(['SET', k, r.v]);
  else if (r.t === 'h') out.push(['HSET', k, ...r.v.flat()]);
  else out.push(['SADD', k, ...r.v]);
  if (r.ttl) out.push(['PEXPIRE', k, r.ttl]);
  return out;
}

/* ---------- часть копии ---------- */
function checkRef(snap, n) {
  if (!SNAP_RE.test(String(snap))) throw berr('format', 'Неверный номер копии');
  if (!Number.isInteger(n) || n < 0) throw berr('format', 'Неверный номер части');
}
// → Buffer для Blob. at — время копии (мс), по умолчанию сейчас.
export function encodePart({ snap, n, recs, at }) {
  checkRef(snap, n);
  for (const r of recs) if (!validRec(r)) throw berr('format', 'Запись копии повреждена');
  const meta = { v: FORMAT, snap, n, at: at || Date.now(), prefix: prefix(), count: recs.length };
  const text = [JSON.stringify(meta)].concat(recs.map((r) => JSON.stringify(r))).join('\n');
  return seal(gzipSync(Buffer.from(text, 'utf8')), snap + '|' + n);
}
// → {meta, recs}. Проверяет шифр, версию формата, номер копии и части, форму каждой записи.
export function decodePart(buf, { snap, n }) {
  checkRef(snap, n);
  const plain = open(buf, snap + '|' + n);
  let text;
  try { text = gunzipSync(plain, { maxOutputLength: MAX_PLAIN }).toString('utf8'); } catch { throw berr('format', 'Часть копии не распаковывается или слишком велика'); }
  const lines = text.split('\n');
  let meta;
  try { meta = JSON.parse(lines[0]); } catch { throw berr('format', 'Заголовок части повреждён'); }
  if (!meta || meta.v !== FORMAT) throw berr('format', 'Неизвестная версия формата копии');
  if (meta.snap !== snap || meta.n !== n) throw berr('tamper', 'Часть не из этой копии');
  const recs = [];
  for (let i = 1; i < lines.length; i++) {
    let r;
    try { r = JSON.parse(lines[i]); } catch { throw berr('format', 'Запись копии повреждена'); }
    if (!validRec(r)) throw berr('format', 'Запись копии повреждена');
    recs.push(r);
  }
  if (recs.length !== meta.count) throw berr('format', 'В части не хватает записей');
  return { meta, recs };
}

/* ---------- чтение базы ---------- */
const READ = { string: ['GET'], hash: ['HGETALL'], set: ['SMEMBERS'] };
const toPairs = (x) => {
  if (Array.isArray(x)) { const p = []; for (let i = 0; i + 1 < x.length; i += 2) p.push([String(x[i]), String(x[i + 1])]); return p; }
  if (x && typeof x === 'object') return Object.entries(x).map(([f, v]) => [String(f), String(v)]); // на случай ответа объектом
  return [];
};
function toRec(rel, type, raw, pttl) {
  let r = null;
  if (type === 'string') { if (raw !== null && raw !== undefined) r = { k: rel, t: 's', v: String(raw) }; }
  else if (type === 'hash') { const v = toPairs(raw); if (v.length) r = { k: rel, t: 'h', v }; }
  else { const v = Array.isArray(raw) ? raw.map(String).sort() : []; if (v.length) r = { k: rel, t: 'e', v }; }
  if (r && pttl > 0) r.ttl = Math.round(pttl);
  return r;
}

// Одиночная команда с ошибкой Redis приходит как HTTP 400 (kind 'http'), ошибка внутри pipeline — как kind 'cmd'; сеть и прочее не глотаем.
const wrongType = (e) => !!e && (e.kind === 'cmd' || e.kind === 'http') && /WRONGTYPE/.test(String(e.message));

// Читает значения ключей. keys — полные имена, types и pttls — ответы TYPE и PTTL в том же порядке.
// Если тип ключа сменился между TYPE и чтением, пачка падает с WRONGTYPE: тогда читаем по одному, такой ключ считаем changed.
export async function readRecs(keys, types, pttls) {
  const p = prefix();
  const recs = [], st = { copied: 0, gone: 0, changed: 0 };
  const items = keys.map((k, i) => ({ k, type: types[i], pttl: pttls[i] }));
  const raws = new Array(items.length).fill(undefined);
  try {
    const res = await pipe(items.map((x) => [...READ[x.type], x.k]));
    res.forEach((v, i) => { raws[i] = v; });
  } catch (e) {
    if (!wrongType(e)) throw e;
    for (let i = 0; i < items.length; i++) {
      try { raws[i] = await cmd(...READ[items[i].type], items[i].k); } catch (e2) { if (wrongType(e2)) raws[i] = undefined; else throw e2; }
    }
  }
  items.forEach((x, i) => {
    if (raws[i] === undefined) { st.changed++; return; }
    const r = toRec(x.k.slice(p.length), x.type, raws[i], x.pttl);
    if (r) { recs.push(r); st.copied++; } else st.gone++;
  });
  return { recs, st };
}

// Один шаг обхода: SCAN от курсора → записи найденных ключей. Вызывать, пока done не станет true; курсор — строка, его можно
// сохранить и продолжить позже (4.2). → {recs, cursor, done, stats:{scanned, copied, gone, changed, foreign, other:{тип: число}}}
export async function readBatch(cursor, opts) {
  const count = Math.max(1, Math.min(1000, Number(opts && opts.count) || 200));
  const p = prefix();
  const r = await cmd('SCAN', String(cursor || '0'), 'MATCH', globEsc(p) + '*', 'COUNT', count);
  const next = String(r[0]);
  const stats = { scanned: 0, copied: 0, gone: 0, changed: 0, foreign: 0, other: {} };
  const found = [...new Set(r[1] || [])];
  stats.scanned = found.length;
  const keys = found.filter((k) => {
    const mine = k.startsWith(p) && (p !== '' || !SKIP_PREFIXES.some((s) => k.startsWith(s)));
    if (!mine) stats.foreign++;
    return mine;
  }).sort();
  const recs = [];
  if (keys.length) {
    const meta = await pipe(keys.flatMap((k) => [['TYPE', k], ['PTTL', k]]));
    const rk = [], rt = [], rp = [];
    keys.forEach((k, i) => {
      const type = String(meta[2 * i]), pttl = Number(meta[2 * i + 1]);
      if (type === 'none' || pttl === -2) stats.gone++;
      else if (!READ[type]) stats.other[type] = (stats.other[type] || 0) + 1;
      else { rk.push(k); rt.push(type); rp.push(pttl); }
    });
    if (rk.length) {
      const got = await readRecs(rk, rt, rp);
      recs.push(...got.recs);
      stats.copied += got.st.copied; stats.gone += got.st.gone; stats.changed += got.st.changed;
    }
  }
  return { recs, cursor: next, done: next === '0', stats };
}

/* ====================== хранение в Vercel Blob (этап 4.2) ======================
Раскладка (всё приватное, всё зашифровано BACKUP_KEY; открытыми остаются только имена файлов):
  backup/<копия>/p<n>.bin        — часть копии (encodePart), n с нуля
  backup/<копия>/manifest.bin    — манифест (конец копии: без него копия считается неполной и не учитывается)
  backup/progress.bin            — ход текущей копии: курсор SCAN, готовые части. Он же замок от двух одновременных запусков.
<копия> = id вида «20261005t183012-ab12»: по алфавиту совпадает с порядком по времени.
Код Redis не пишет: ход копии лежит в Blob, чтобы не попадать в саму копию. */
// Папка копий в Blob. По умолчанию «backup»; BACKUP_DIR нужна только проверке tests/live-blob.mjs, чтобы не трогать настоящие копии.
const dir = () => { const d = String(process.env.BACKUP_DIR || 'backup').replace(/^\/+|\/+$/g, ''); return (/^[a-z0-9][a-z0-9_-]{0,60}$/i.test(d) ? d : 'backup') + '/'; };
const progPath = () => dir() + 'progress.bin';
export const KEEP = 7;               // сколько полных копий хранить
export const PART_BYTES = 1024 * 1024; // сколько записей (в байтах открытого текста) собирать в одну часть
export const BUDGET_MS = 22000;      // сколько времени работать за вызов (maxDuration функции 30 с)
export const LEASE_MS = 45000;       // замок: ход копии моложе этого срока считается занятым другим запуском
export const STALE_MS = 20 * 3600 * 1000; // ход старше этого срока не продолжается: копия должна быть из одного дня
const MANIFEST_V = 1;

const partPath = (snap, n) => dir() + snap + '/p' + n + '.bin';
const manPath = (snap) => dir() + snap + '/manifest.bin';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const isPre = (e) => /precondition|already\s*exists/i.test(String(e && (e.name + ' ' + e.message)));
const isMissing = (e) => /not\s*found|404/i.test(String(e && (e.message || e.name)));

// Пакет подключается при первом обращении к Blob: ядро (чтение базы, шифр) работает и без него.
let blobMod = null;
const blob = async () => blobMod || (blobMod = await import('@vercel/blob'));
const ref = (b) => b.url || b.pathname;

async function bput(path, buf, extra) {
  const B = await blob();
  return B.put(path, buf, { access: 'private', addRandomSuffix: false, contentType: 'application/octet-stream', ...extra });
}
// → {buf, etag} или null, если файла нет.
async function bget(path) {
  const B = await blob();
  try {
    const r = await B.get(path, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return null;
    const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
    let etag = r.blob && r.blob.etag;
    if (!etag) { try { etag = (await B.head(path)).etag; } catch { etag = null; } }
    return { buf, etag };
  } catch (e) { if (isMissing(e)) return null; throw e; }
}
async function blist(prefix) {
  const B = await blob();
  const out = [];
  let cursor;
  for (let page = 0; page < 100; page++) {
    const r = await B.list({ prefix, cursor, limit: 1000 });
    out.push(...((r && r.blobs) || []));
    if (!r || !r.hasMore || !r.cursor) return out;
    cursor = r.cursor;
  }
  throw berr('blob', 'Слишком много файлов в хранилище копий');
}
async function bdel(items) {
  const B = await blob();
  for (let i = 0; i < items.length; i += 100) await B.del(items.slice(i, i + 100).map(ref));
}

const sealJson = (obj, aad) => seal(gzipSync(Buffer.from(JSON.stringify(obj), 'utf8')), aad);
function openJson(buf, aad) {
  let o;
  try { o = JSON.parse(gunzipSync(open(buf, aad), { maxOutputLength: MAX_PLAIN }).toString('utf8')); } catch (e) { if (e && e.name === 'BackupError') throw e; throw berr('format', 'Служебный файл копии повреждён'); }
  return o;
}
const newSnap = (now) => new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').toLowerCase() + '-' + randomBytes(2).toString('hex');
const snapOf = (path) => { const d = dir(); if (!path.startsWith(d)) return null; const m = /^([0-9a-z][0-9a-z-]{3,39})\//.exec(path.slice(d.length)); return m ? m[1] : null; };

function sumStats(a, b) {
  const o = { ...a.other };
  for (const [t, n] of Object.entries(b.other || {})) o[t] = (o[t] || 0) + n;
  return { scanned: a.scanned + b.scanned, copied: a.copied + b.copied, gone: a.gone + b.gone, changed: a.changed + b.changed, foreign: a.foreign + b.foreign, other: o };
}
const zeroStats = () => ({ scanned: 0, copied: 0, gone: 0, changed: 0, foreign: 0, other: {} });

async function readProgress() {
  const g = await bget(progPath());
  if (!g) return null;
  let p;
  try { p = openJson(g.buf, 'progress'); } catch (e) { if (e && e.name === 'BackupError') return { bad: true, etag: g.etag }; throw e; } // другой ключ, порча: ход непригоден
  if (!p || p.v !== MANIFEST_V || !SNAP_RE.test(String(p.snap)) || !Array.isArray(p.parts) || typeof p.cursor !== 'string' || !Number.isInteger(p.n) || !(p.upd > 0) || !(p.at > 0)) return { bad: true, etag: g.etag };
  return { p, etag: g.etag };
}

// Одна копия: идёт до конца или до конца бюджета времени.
// → {state:'done', snap, parts, keys, bytes, stats, pruned} | {state:'partial', snap, parts, keys} (повторить вызов) | {state:'busy'} (другой запуск работает).
// opts: budgetMs, count (ключей за шаг SCAN), partBytes, keep, now (функция времени, для тестов).
export async function runBackup(opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const t0 = now();
  const budget = o.budgetMs || BUDGET_MS;
  const partBytes = o.partBytes || PART_BYTES;
  backupKey(); // ошибка настройки до любых обращений к хранилищу
  if (!dbReady()) throw berr('config', 'Redis не настроен');

  // --- ход: продолжить свежий или начать новую копию (ход создаётся с allowOverwrite:false, это и есть замок)
  let cur = await readProgress();
  if (cur && cur.bad) { // ход нельзя прочитать (сменили BACKUP_KEY или файл испорчен): не блокируем копии навсегда, начинаем заново
    await bdel([{ pathname: progPath() }]);
    cur = null;
  }
  if (cur && (await bget(manPath(cur.p.snap)))) { // прошлый запуск закончил копию, но не убрал ход
    await bdel([{ pathname: progPath() }]);
    cur = null;
  }
  if (cur && now() - cur.p.upd < LEASE_MS) return { state: 'busy' };
  if (cur && now() - cur.p.at > STALE_MS) { // устаревший ход: копия должна быть из одного дня
    await bdel((await blist(dir() + cur.p.snap + '/')));
    await bdel([{ pathname: progPath() }]);
    cur = null;
  }
  let p, etag;
  if (cur) { p = cur.p; etag = cur.etag; } else {
    p = { v: MANIFEST_V, snap: newSnap(now()), at: now(), upd: now(), cursor: '0', done: false, n: 0, parts: [], stats: zeroStats() };
    try { etag = (await bput(progPath(), sealJson(p, 'progress'), { allowOverwrite: false })).etag; } catch (e) { if (isPre(e)) return { state: 'busy' }; throw e; }
  }
  const save = async () => {
    p.upd = now();
    try { etag = (await bput(progPath(), sealJson(p, 'progress'), { allowOverwrite: true, ifMatch: etag })).etag; } catch (e) { if (isPre(e)) throw Object.assign(berr('busy', 'Копию ведёт другой запуск'), { busy: true }); throw e; }
  };

  // --- обход
  let buf = [], bufBytes = 0, done = !!p.done;
  const flush = async () => {
    if (!buf.length) return;
    const sealed = encodePart({ snap: p.snap, n: p.n, recs: buf, at: p.at });
    await bput(partPath(p.snap, p.n), sealed, { allowOverwrite: true });
    p.parts.push({ n: p.n, bytes: sealed.length, count: buf.length, sha: sha(sealed) });
    p.n++; buf = []; bufBytes = 0;
  };
  try {
    if (cur) await save(); // продлить замок
    while (!done) {
      if (now() - t0 > budget) break;
      const r = await readBatch(p.cursor, { count: o.count });
      for (const rec of r.recs) { buf.push(rec); bufBytes += recSize(rec); }
      p.stats = sumStats(p.stats, r.stats);
      p.cursor = r.cursor; p.done = r.done; done = r.done;
      if (bufBytes >= partBytes || done || now() - t0 > budget) { await flush(); await save(); }
    }
    if (!done) { await flush(); await save(); }
  } catch (e) { if (e && e.busy) return { state: 'busy' }; throw e; }
  const keys = p.parts.reduce((a, x) => a + x.count, 0);
  if (!done) return { state: 'partial', snap: p.snap, parts: p.parts.length, keys };

  // --- конец: манифест (после него копия считается полной), убрать ход, убрать лишние копии
  const bytes = p.parts.reduce((a, x) => a + x.bytes, 0);
  const man = { v: MANIFEST_V, snap: p.snap, at: p.at, end: now(), prefix: prefix(), parts: p.parts, keys, bytes, stats: p.stats };
  await bput(manPath(p.snap), sealJson(man, p.snap + '|manifest'), { allowOverwrite: true });
  await bdel([{ pathname: progPath() }]);
  const pruned = await pruneBackups(o.keep || KEEP);
  return { state: 'done', snap: p.snap, parts: p.parts.length, keys, bytes, stats: p.stats, pruned };
}

// Оставляет `keep` самых новых полных копий. Копии без манифеста, не принадлежащие текущему ходу, удаляются.
// → число удалённых копий.
export async function pruneBackups(keep) {
  const files = await blist(dir());
  const groups = new Map();
  for (const f of files) {
    const s = snapOf(f.pathname);
    if (!s) continue;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(f);
  }
  let live = null;
  try { const c = await readProgress(); live = c && c.p ? c.p.snap : null; } catch { live = null; }
  const complete = [...groups.keys()].filter((s) => groups.get(s).some((f) => f.pathname === manPath(s))).sort().reverse();
  const drop = new Set(complete.slice(Math.max(1, keep || KEEP)));
  for (const s of groups.keys()) if (!complete.includes(s) && s !== live) drop.add(s);
  for (const s of drop) await bdel(groups.get(s));
  return drop.size;
}

// Список копий (новые первыми): [{snap, complete, at, end, keys, parts, bytes, prefix, error?}]. Для неполных только snap и complete:false.
// error: 'key' | 'tamper' | 'format', если манифест не читается (другой BACKUP_KEY и т. п.).
export async function listBackups() {
  const files = await blist(dir());
  const snaps = new Map();
  for (const f of files) {
    const s = snapOf(f.pathname);
    if (!s) continue;
    if (!snaps.has(s)) snaps.set(s, false);
    if (f.pathname === manPath(s)) snaps.set(s, true);
  }
  const out = [];
  for (const s of [...snaps.keys()].sort().reverse()) {
    if (!snaps.get(s)) { out.push({ snap: s, complete: false }); continue; }
    try {
      const m = await readManifest(s);
      out.push({ snap: s, complete: true, at: m.at, end: m.end, keys: m.keys, parts: m.parts.length, bytes: m.bytes, prefix: m.prefix });
    } catch (e) { out.push({ snap: s, complete: true, error: e && e.kind || 'format' }); }
  }
  return out;
}

export async function readManifest(snap) {
  if (!SNAP_RE.test(String(snap))) throw berr('format', 'Неверный номер копии');
  const g = await bget(manPath(snap));
  if (!g) throw berr('missing', 'Копия не найдена или не закончена');
  const m = openJson(g.buf, snap + '|manifest');
  if (!m || m.v !== MANIFEST_V || m.snap !== snap || !Array.isArray(m.parts)) throw berr('format', 'Манифест копии повреждён');
  return m;
}

// Читает часть копии из Blob, проверяет размер и sha из манифеста, расшифровывает. → {meta, recs}
export async function readPart(snap, man, n) {
  const info = man.parts.find((x) => x.n === n);
  if (!info) throw berr('format', 'Части ' + n + ' нет в манифесте');
  const g = await bget(partPath(snap, n));
  if (!g) throw berr('missing', 'Не найдена часть ' + n);
  if (g.buf.length !== info.bytes || sha(g.buf) !== info.sha) throw berr('tamper', 'Часть ' + n + ' не совпадает с манифестом (повреждена или заменена)');
  const r = decodePart(g.buf, { snap, n });
  if (r.recs.length !== info.count) throw berr('format', 'В части ' + n + ' не то число записей');
  return r;
}

// Проверка копии без восстановления: все части на месте, размеры и sha совпадают, расшифровываются, записи целы, число ключей как в манифесте.
// → {ok, snap, parts, keys, problems:[«часть N: …»]}. Секретов и содержимого записей в ответе нет.
export async function verifyBackup(snap) {
  const man = await readManifest(snap);
  const problems = [];
  let keys = 0;
  for (const info of man.parts) {
    try { keys += (await readPart(snap, man, info.n)).recs.length; } catch (e) { problems.push('часть ' + info.n + ': ' + (e && e.message || 'ошибка')); }
  }
  if (!problems.length && keys !== man.keys) problems.push('число ключей ' + keys + ' не совпадает с манифестом ' + man.keys);
  return { ok: problems.length === 0, snap, parts: man.parts.length, keys, problems };
}

/* ====================== запуск по расписанию (этап 4.3) ====================== */
export const DUE_GAP_MS = 20 * 3600 * 1000; // новая копия нужна, если последней полной больше этого срока (cron зовёт копию в оба слота: сбой утром доделывается вечером)
// Время копии из её номера («20261005t180000-ab12» → мс UTC).
export function snapTime(snap) {
  const m = /^(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})(\d{2})-/.exec(String(snap));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// Состояние без расшифровки и без записи (только список файлов): {configured, copies, lastAt, running}.
// configured — задан ли BACKUP_KEY; copies — полные копии (с манифестом); lastAt — время самой новой полной; running — есть файл хода.
export async function backupStatus() {
  const files = await blist(dir());
  const full = [];
  let running = false;
  for (const f of files) {
    if (f.pathname === progPath()) { running = true; continue; }
    const s = snapOf(f.pathname);
    if (s && f.pathname === manPath(s)) full.push(s);
  }
  full.sort();
  return { configured: backupReady(), copies: full.length, lastAt: full.length ? snapTime(full[full.length - 1]) : null, running };
}

// Копия по расписанию: если идёт незаконченная, продолжает её; иначе делает новую, только если последней полной больше DUE_GAP_MS.
// → результат runBackup или {state:'skip', lastAt}. opts как у runBackup, плюс minGapMs.
export async function backupIfDue(opts) {
  const o = opts || {};
  const now = (o.now || Date.now)();
  const st = await backupStatus();
  if (!st.running && st.lastAt && now - st.lastAt < (o.minGapMs || DUE_GAP_MS)) return { state: 'skip', lastAt: st.lastAt };
  return runBackup(o);
}

