// Выгрузка новых магазинов из личных псевдонимов бота (этап 5). ТОЛЬКО ЧТЕНИЕ: ничего не пишет в Redis, режима --apply нет.
// Люди добавляют боту магазины вручную («Не та категория», новый магазин): это личные псевдонимы alias в bot:<id>. Скрипт собирает их
// со всех аккаунтов и показывает, чего нет в словаре SHOPS (api/_shops.js), чтобы владелец прописал это в код для всех.
//
// Запуск (PowerShell, из корня репозитория; значения переменных в файлы не писать, задавать только в окне; нужен npm i):
//   $env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; $env:DB_PREFIX='t:'   # тот же префикс, что в Vercel у боевого проекта; пустой префикс — другая, пустая база
//   node scripts/export-shops.mjs                          # отчёт в окне
//   node scripts/export-shops.mjs --min=2 --out=shops.txt  # только то, что добавили минимум 2 аккаунта; ещё и в файл exports/shops.txt (UTF-8)
// Флаги: --min=N (порог числа РАЗНЫХ аккаунтов, по умолчанию 1), --out=файл (имя файла в папке exports/; существующий файл не перезаписывается;
// обычное > в Windows PowerShell пишет UTF-16, поэтому есть --out), --help.
// Разделы отчёта: 1) новые магазины (в готовых строках для SHOPS), 2) уже в словаре: другое написание (кандидаты в алиасы),
// 3) исправления категории словаря, 4) свои категории с сайта (в SHOPS не идут). Запросы-категории, «не знаю точно» и пустое пропускаются, считается общим числом.
// Приватность: в отчёт идут только названия, категории и числа. Ни id аккаунтов, ни почт, ни Telegram-id (аккаунты различаются только числом).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dbReady, prefix, cmd } from '../api/_db.js';
import { readBot } from '../api/_bot.js';
import { CATS } from '../api/_lib.js';
import { lookup, norm, disp } from '../api/_shops.js';
import { globEsc } from '../api/_backup.js';
import { chunks } from './_cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Строка в одинарных кавычках для вставки в код: без управляющих символов, с экранированием \ и '.
const q = (s) => "'" + String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const oneLine = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

// Чистая часть (без Redis). items: [{ u: номер аккаунта, key, c, t }]. → отчёт со всеми разделами (порог применяется в render).
export function layout(items) {
  const rep = { total: 0, skipped: 0, fresh: [], known: [], fixes: [], foreign: [] };
  const fresh = new Map(), known = new Map(), fixes = new Map(), foreign = new Map();
  const add = (map, id, u, init) => { let g = map.get(id); if (!g) { g = Object.assign({ users: new Set() }, init); map.set(id, g); } g.users.add(u); return g; };
  for (const it of items) {
    rep.total++;
    const key = typeof it.key === 'string' ? norm(it.key) : '';
    if (!key || typeof it.c !== 'string' || !it.c) { rep.skipped++; continue; }
    if (!CATS.includes(it.c)) { const g = add(foreign, it.c, it.u, { cat: it.c, n: 0 }); g.n++; continue; }
    const res = lookup(key);
    if (res.kind === 'unknown') {
      const g = add(fresh, key + '|' + it.c, it.u, { key, cat: it.c, titles: new Map() });
      const t = oneLine(it.t && typeof it.t === 'string' ? it.t : disp(key)) || disp(key);
      g.titles.set(t, (g.titles.get(t) || 0) + 1);
    } else if (res.kind === 'found' && !res.byCat) {
      if (norm(res.title) !== key) add(known, res.title + '|' + key, it.u, { shop: res.title, key });
      else if (res.cats.length !== 1 || res.cats[0] !== it.c) add(fixes, res.title + '|' + it.c, it.u, { shop: res.title, dict: res.cats.join('+'), cat: it.c });
      else rep.skipped++; // псевдоним совпал со словарём: ничего нового
    } else rep.skipped++; // категория или «не знаю точно»
  }
  const size = (g) => g.users.size;
  rep.fresh = [...fresh.values()].map((g) => {
    const best = [...g.titles.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))[0];
    return { title: best[0], cat: g.cat, key: g.key, n: size(g) };
  });
  rep.known = [...known.values()].map((g) => ({ shop: g.shop, key: g.key, n: size(g) }));
  rep.fixes = [...fixes.values()].map((g) => ({ shop: g.shop, dict: g.dict, cat: g.cat, n: size(g) }));
  rep.foreign = [...foreign.values()].map((g) => ({ cat: g.cat, n: size(g), aliases: g.n }));
  return rep;
}

const byN = (a, b) => b.n - a.n;
const str = (a, b) => a.localeCompare(b, 'ru');

// Отчёт текстом. opts: { min, accounts } — порог числа аккаунтов и сколько аккаунтов прочитано.
export function render(rep, opts) {
  const min = Math.max(1, Number(opts && opts.min) || 1);
  const out = [];
  let hidden = 0;
  const keep = (list) => list.filter((g) => { if (g.n >= min) return true; hidden++; return false; });
  out.push('Личные псевдонимы бота: аккаунтов с псевдонимами ' + ((opts && opts.accounts) || 0) + ', псевдонимов ' + rep.total + ', порог --min=' + min + '.');
  const fresh = keep(rep.fresh), known = keep(rep.known), fixes = keep(rep.fixes), foreign = keep(rep.foreign);
  out.push('', '== 1. Новые магазины (в словаре нет): строки для SHOPS ==');
  if (!fresh.length) out.push('// нет');
  for (const c of CATS) {
    const rows = fresh.filter((g) => g.cat === c).sort((a, b) => byN(a, b) || str(a.title, b.title));
    if (!rows.length) continue;
    out.push('  // ' + c);
    for (const g of rows) out.push('  [' + q(g.title) + ', ' + q(g.cat) + ', []], // аккаунтов: ' + g.n);
  }
  out.push('', '== 2. Уже в словаре, другое написание: кандидаты в алиасы (проверить глазами: запрос мог относиться к другому магазину) ==');
  if (!known.length) out.push('// нет');
  const shops = [...new Set(known.map((g) => g.shop))].sort(str);
  for (const s of shops) {
    const rows = known.filter((g) => g.shop === s).sort((a, b) => byN(a, b) || str(a.key, b.key));
    out.push('// ' + oneLine(s) + ': ' + rows.map((g) => q(g.key) + ' (аккаунтов: ' + g.n + ')').join(', '));
  }
  out.push('', '== 3. Исправления категории словаря (много аккаунтов: возможна ошибка словаря) ==');
  if (!fixes.length) out.push('// нет');
  for (const g of fixes.sort((a, b) => byN(a, b) || str(a.shop, b.shop))) out.push('// ' + oneLine(g.shop) + ': в словаре «' + g.dict + '», выбрано «' + g.cat + '» (аккаунтов: ' + g.n + ')');
  out.push('', '== 4. Свои категории с сайта (в SHOPS не идут) ==');
  if (!foreign.length) out.push('// нет');
  for (const g of foreign.sort((a, b) => byN(a, b) || str(a.cat, b.cat))) out.push('// ' + oneLine(g.cat) + ': аккаунтов ' + g.n + ', псевдонимов ' + g.aliases);
  out.push('', 'Пропущено без разбора (категории, «не знаю точно», пустое, совпало со словарём): ' + rep.skipped + (hidden ? '; скрыто порогом --min: ' + hidden + ' групп' : '') + '.');
  return out.join('\n');
}

// Разбор аргументов: --min=N, --out=файл (или через пробел), --help. → { min, out, help } или { error }.
export function parseArgs(argv) {
  const r = { min: 1, out: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const val = (name) => (a === name ? (i + 1 < argv.length ? String(argv[++i]) : '') : a.slice(name.length + 1));
    if (a === '--help') r.help = true;
    else if (a === '--min' || a.startsWith('--min=')) { const v = val('--min'); if (!/^[1-9]\d{0,5}$/.test(v)) return { error: '--min: нужно целое число от 1' }; r.min = Number(v); }
    else if (a === '--out' || a.startsWith('--out=')) { const v = val('--out'); if (!v || v !== path.basename(v) || v.startsWith('.')) return { error: '--out: нужно просто имя файла (он будет в папке exports/)' }; r.out = v; }
    else return { error: 'Неизвестный аргумент: ' + a.slice(0, 40) };
  }
  return r;
}

// Все ключи bot:<id> с текущим DB_PREFIX → массив id (SCAN, повторы убраны).
async function botIds() {
  const p = prefix() + 'bot:';
  const ids = new Set();
  let cursor = '0';
  do {
    const r = await cmd('SCAN', cursor, 'MATCH', globEsc(p) + '*', 'COUNT', 500);
    cursor = String(r[0]);
    for (const k of r[1] || []) if (typeof k === 'string' && k.startsWith(p) && k.length > p.length) ids.add(k.slice(p.length));
  } while (cursor !== '0');
  return [...ids];
}

// Читает личные псевдонимы всех аккаунтов. → { items, accounts, failed }. Пачки по 20 чтений.
export async function collect() {
  const ids = await botIds();
  const items = [];
  let accounts = 0, failed = 0;
  let u = 0;
  for (const part of chunks(ids, 20)) {
    const res = await Promise.all(part.map((id) => readBot(id).then((r) => r.state, () => null)));
    for (const st of res) {
      if (!st) { failed++; continue; }
      const keys = Object.keys(st.alias);
      if (!keys.length) continue;
      accounts++; u++;
      for (const k of keys) { const a = st.alias[k]; if (a && typeof a === 'object') items.push({ u, key: k, c: a.c, t: a.t }); else items.push({ u, key: k, c: null, t: null }); }
    }
  }
  return { items, accounts, failed, bots: ids.length };
}

// Запись отчёта в exports/<имя>: существующий файл не перезаписывается.
const defaultSave = (name, text) => {
  const dir = path.join(ROOT, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text + '\n', { encoding: 'utf8', flag: 'wx' });
};

export async function main(argv = process.argv.slice(2), io = { log: console.log, save: defaultSave }) {
  const { log } = io;
  const save = io.save || defaultSave;
  const a = parseArgs(argv);
  if (a.error) { log(a.error + '. Справка: node scripts/export-shops.mjs --help'); return 1; }
  if (a.help) { log('Использование: node scripts/export-shops.mjs [--min=N] [--out=файл]; только чтение (см. комментарий в начале файла).'); return 0; }
  if (!dbReady()) { log('Нужны KV_REST_API_URL и KV_REST_API_TOKEN (запасные UPSTASH_REDIS_REST_*).'); return 1; }
  const c = await collect();
  const text = (prefix() ? 'Префикс базы: ' + prefix() : 'Префикс базы пуст (в бою DB_PREFIX=t:, проверьте переменную)') + '\n' + render(layout(c.items), { min: a.min, accounts: c.accounts }) + (c.failed ? '\nНе удалось прочитать аккаунтов: ' + c.failed + ' (отчёт неполный, повторите позже).' : '');
  log(text);
  if (a.out) {
    try { save(a.out, text); log('Записано: exports/' + a.out); }
    catch (e) { log(e && e.code === 'EEXIST' ? 'Файл exports/' + a.out + ' уже есть: укажите другое имя или удалите его.' : 'Файл не записан: ' + (e && (e.code || e.name))); return 1; }
  }
  return c.failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().then((c) => { process.exitCode = c; }, (e) => { console.error('Ошибка:', e && (e.kind || e.name), e && e.message); process.exitCode = 1; });
