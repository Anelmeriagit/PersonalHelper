// Восстановление Redis из резервной копии в Blob (этап 4.4). По умолчанию СУХОЙ ПРОГОН: ничего не записывает.
//
// Запуск (PowerShell, из корня репозитория; значения переменных в файлы не писать, задавать только в окне; нужен npm i):
//   $env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; $env:BLOB_READ_WRITE_TOKEN='...'; $env:BACKUP_KEY='...'
//   $env:DB_PREFIX=''                                  # пусто = боевая база (куда восстанавливать по умолчанию)
//   node scripts/restore-backup.mjs --list             # какие копии есть (дата, ключей, частей), только чтение
//   node scripts/restore-backup.mjs --verify           # проверить новейшую копию целиком (шифр, sha, записи), только чтение, Redis не нужен
//   node scripts/restore-backup.mjs --drill            # ПРОВЕРКА ВОССТАНОВЛЕНИЯ: развернуть копию в одноразовый префикс, сверить с копией, удалить; боевое не трогается
//   node scripts/restore-backup.mjs                    # сухой прогон восстановления: что будет создано и что перезаписано
//   node scripts/restore-backup.mjs --apply            # восстановить (спросит подтверждение: RESTORE; в боевую базу: RESTORE PROD)
// Флаги: --snap=<номер> (по умолчанию новейшая полная и читаемая), --to=<префикс> (куда восстанавливать вместо DB_PREFIX, например t),
//        --all (вернуть и временные ключи rl: и tgt:, по умолчанию они пропускаются), --skip=a,b (пропустить виды ключей, вместо rl,tgt),
//        --yes (не спрашивать подтверждение; только для автоматического запуска), --help.
//
// Что делает восстановление: каждый ключ копии записывается заново (сначала DEL, потом запись, потом срок жизни), ключи, которых нет в копии, не трогаются.
// Перед записью копия проверяется целиком; если часть повреждена или подменена, не пишется ничего. После записи каждый ключ читается обратно и сверяется с копией.
// Переменные окружения: KV_REST_API_URL, KV_REST_API_TOKEN (запасные UPSTASH_REDIS_REST_*), DB_PREFIX, BLOB_READ_WRITE_TOKEN, BACKUP_KEY, BACKUP_DIR (необязательно).
// В вывод идут только числа, виды ключей и номер копии: ни адресов, ни токенов, ни ключей шифрования, ни содержимого записей, ни id аккаунтов.
import { pathToFileURL } from 'node:url';
import { cmd, pipe, prefix, dbReady } from '../api/_db.js';
import { listBackups, readManifest, readPart, verifyBackup, restoreCmds, normPrefix, globEsc, readRecs, recSize } from '../api/_backup.js';

export const DEFAULT_SKIP = ['rl', 'tgt']; // временные ключи: счётчики лимитов и одноразовые ссылки привязки
const SEND_BYTES = 200 * 1024; // сколько записей отправлять в Redis одним запросом (в байтах JSON)
const EXISTS_CHUNK = 200;

const kindOf = (k) => String(k).split(':')[0];
const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '?');
const fmtKinds = (m) => Object.keys(m).sort().map((k) => k + ' ' + m[k]).join(', ') || 'нет';
const chunks = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };
const add = (m, k, n = 1) => { m[k] = (m[k] || 0) + n; };

// Сверка записанного с копией: читает ключи обратно (с текущим DB_PREFIX) и сравнивает тип, значение и срок жизни.
// → { checked, mismatches, expired }. Просроченный временный ключ (срок в копии не больше ageMs) не считается расхождением.
export async function compareRecs(recs, ageMs) {
  const p = prefix();
  let mismatches = 0, expired = 0;
  const keys = recs.map((r) => p + r.k);
  const meta = await pipe(keys.flatMap((k) => [['TYPE', k], ['PTTL', k]]));
  const have = [];
  recs.forEach((r, i) => {
    const type = String(meta[2 * i]);
    const want = { s: 'string', h: 'hash', e: 'set' }[r.t];
    if (type === 'none') { if (r.ttl && r.ttl <= (ageMs || 0) + 1000) expired++; else mismatches++; return; }
    if (type !== want) { mismatches++; return; }
    const pttl = Number(meta[2 * i + 1]);
    if (r.ttl ? !(pttl > 0 && pttl <= r.ttl + 1000) : pttl !== -1) { mismatches++; return; }
    have.push({ r, type, pttl, key: keys[i] });
  });
  if (have.length) {
    const got = await readRecs(have.map((x) => x.key), have.map((x) => x.type), have.map((x) => x.pttl));
    const byKey = new Map(got.recs.map((g) => [g.k, g]));
    const norm = (r) => JSON.stringify(r.t === 'h' ? r.v.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) : r.t === 'e' ? r.v.slice().sort() : r.v);
    for (const { r } of have) { const g = byKey.get(r.k); if (!g || g.t !== r.t || norm(g) !== norm(r)) mismatches++; }
  }
  return { checked: recs.length, mismatches, expired };
}

// Все ключи с текущим DB_PREFIX удалить (только для одноразового префикса проверки). → сколько удалено.
async function wipePrefix() {
  const p = prefix();
  if (!p) throw new Error('внутренняя ошибка: очистка пустого префикса запрещена');
  let n = 0, cur = '0';
  do {
    const r = await cmd('SCAN', cur, 'MATCH', globEsc(p) + '*', 'COUNT', 500);
    cur = String(r[0]);
    const keys = (r[1] || []).filter((k) => k.startsWith(p));
    for (const part of chunks(keys, 100)) n += Number(await cmd('DEL', ...part)) || 0;
  } while (cur !== '0');
  return n;
}

// Есть ли хоть один ключ с текущим DB_PREFIX (SCAN до первой находки).
async function anyKey() {
  const p = prefix();
  let cur = '0';
  do {
    const r = await cmd('SCAN', cur, 'MATCH', globEsc(p) + '*', 'COUNT', 500);
    cur = String(r[0]);
    if ((r[1] || []).some((k) => k.startsWith(p))) return true;
  } while (cur !== '0');
  return false;
}

// Записи частей по очереди (части читаются из Blob с проверкой sha и шифра), с пропуском видов ключей.
async function* parts(snap, man, skip) {
  for (const info of man.parts) {
    const recs = (await readPart(snap, man, info.n)).recs;
    const keep = recs.filter((r) => !skip.includes(kindOf(r.k)));
    yield { n: info.n, recs: keep, skipped: recs.length - keep.length };
  }
}

// io: { log(строка), confirm(вопрос) → Promise<bool> }
// opts: { list, verify, apply, yes, to, all, skip, snap, drill }
// → { ok, mode, snap, plan?, restored?, mismatches?, problems? }. Ошибки настройки и сбои хранилищ выбрасываются.
export async function run(opts, io) {
  const log = io.log;
  const o = opts || {};
  const saved = process.env.DB_PREFIX;
  try {
    // --- только чтение: список и проверка
    if (o.list) {
      const l = await listBackups();
      log('Копий в хранилище: ' + l.length);
      for (const x of l) log('  ' + x.snap + (x.complete ? (x.error ? '  НЕ ЧИТАЕТСЯ (' + x.error + ')' : '  ' + when(x.at) + ', ключей ' + x.keys + ', частей ' + x.parts + ', ' + x.bytes + ' байт' + (x.prefix ? ', префикс «' + x.prefix + '»' : '')) : '  не закончена (манифеста нет)'));
      return { ok: true, mode: 'list', copies: l };
    }
    const pick = async () => {
      if (o.snap) return o.snap;
      const l = (await listBackups()).filter((x) => x.complete && !x.error);
      if (!l.length) throw new Error('Нет ни одной полной читаемой копии (проверьте BACKUP_KEY и список: --list)');
      return l[0].snap;
    };
    const snap = await pick();
    const v = await verifyBackup(snap);
    if (o.verify) {
      log('Копия ' + snap + ': частей ' + v.parts + ', ключей ' + v.keys + (v.ok ? ', проверка пройдена (шифр, sha, записи)' : ', ПРОБЛЕМЫ: ' + v.problems.length));
      for (const pr of v.problems) log('  ' + pr);
      return { ok: v.ok, mode: 'verify', snap, problems: v.problems };
    }
    if (!v.ok) {
      log('Копия ' + snap + ' повреждена, восстановление остановлено, ничего не записано:');
      for (const pr of v.problems) log('  ' + pr);
      return { ok: false, mode: 'refused', snap, problems: v.problems };
    }

    // --- куда и что
    const drill = !!o.drill;
    const stamp = Date.now().toString(36);
    const to = drill ? normPrefix('drill' + stamp) : o.to !== undefined ? normPrefix(o.to) : prefix();
    process.env.DB_PREFIX = to;
    if (!dbReady()) throw new Error('Redis не настроен: задайте KV_REST_API_URL и KV_REST_API_TOKEN');
    const skip = o.all ? [] : (o.skip || DEFAULT_SKIP);
    const man = await readManifest(snap);
    const apply = !!(o.apply || drill);
    if (drill && (await anyKey())) throw new Error('Одноразовый префикс проверки уже занят (повторите запуск): очистка чужих ключей запрещена');
    log((drill ? 'РЕЖИМ: проверка восстановления (одноразовый префикс, потом удаляется)' : apply ? 'РЕЖИМ: ПРИМЕНЕНИЕ' : 'РЕЖИМ: сухой прогон (ничего не меняется)') + '. Копия ' + snap + ' от ' + when(man.at) + ', ключей ' + man.keys + ', префикс копии «' + (man.prefix || '') + '»');
    log('Куда: префикс «' + (to || '(пусто: боевая база)') + '»' + (skip.length ? '; пропускаются виды: ' + skip.join(', ') + ' (флаг --all вернёт и их)' : ''));

    // --- план: сколько создастся и сколько перезапишется
    const kinds = {}, skipKinds = {};
    let create = 0, overwrite = 0, total = 0, skippedN = 0;
    for await (const part of parts(snap, man, [])) {
      const keep = [];
      for (const r of part.recs) { if (skip.includes(kindOf(r.k))) { add(skipKinds, kindOf(r.k)); skippedN++; } else { keep.push(r); add(kinds, kindOf(r.k)); } }
      total += keep.length;
      if (!keep.length) continue;
      const ex = await pipe(keep.map((r) => ['EXISTS', to + r.k]));
      ex.forEach((e) => { if (Number(e)) overwrite++; else create++; });
    }
    log('План: восстановить ключей ' + total + ' (' + fmtKinds(kinds) + '): создать ' + create + ', перезаписать ' + overwrite + (skippedN ? '; пропущено временных ' + skippedN + ' (' + fmtKinds(skipKinds) + ')' : ''));
    const plan = { total, create, overwrite, skipped: skippedN, kinds };
    if (!apply) {
      log(total ? 'Сухой прогон завершён: ничего не изменено. Чтобы восстановить, добавьте --apply; чтобы только проверить, что копия разворачивается, --drill.' : 'Сухой прогон завершён: восстанавливать нечего.');
      return { ok: true, mode: 'dry', snap, plan };
    }

    // --- подтверждение
    if (!drill && !o.yes) {
      const word = to ? 'RESTORE' : 'RESTORE PROD';
      const q = 'Будет записано ключей: ' + total + ' (перезаписано существующих: ' + overwrite + ')' + (to ? ' в префикс «' + to + '»' : ' В БОЕВУЮ БАЗУ') + '. Перезапись необратима. Введите ' + word + ': ';
      if (!(await io.confirm(q, word))) { log('Отменено: подтверждение не получено, ничего не изменено.'); return { ok: false, mode: 'cancelled', snap, plan }; }
    }

    // --- запись и сверка
    const t0 = Date.now();
    let restored = 0, mismatches = 0, expired = 0;
    for await (const part of parts(snap, man, skip)) {
      let batch = [], bytes = 0;
      const send = async () => { if (batch.length) { await pipe(batch.flatMap((r) => restoreCmds(r, to))); batch = []; bytes = 0; } };
      for (const r of part.recs) { batch.push(r); bytes += recSize(r); if (bytes >= SEND_BYTES) await send(); }
      await send();
      const c = await compareRecs(part.recs, Date.now() - t0);
      restored += part.recs.length; mismatches += c.mismatches; expired += c.expired;
      log('  часть ' + part.n + ': записано ' + part.recs.length + ', расхождений при сверке ' + c.mismatches);
    }
    let wiped = 0;
    if (drill) { wiped = await wipePrefix(); log('Одноразовый префикс очищен: удалено ключей ' + wiped); }
    const ok = mismatches === 0 && (!drill || wiped >= restored - expired);
    log(ok ? (drill ? 'Проверка восстановления пройдена: копия ' + snap + ' разворачивается, ' + restored + ' ключей совпали с копией, боевая база не затронута.' : 'Готово: восстановлено ' + restored + ' ключей, все совпали с копией.') : 'ВНИМАНИЕ: расхождений при сверке ' + mismatches + (drill && wiped < restored - expired ? ', при очистке удалено меньше ключей, чем записано' : '') + '. Не считайте восстановление удавшимся.');
    return { ok, mode: drill ? 'drill' : 'apply', snap, to, plan, restored, mismatches, expired, wiped };
  } finally {
    if (saved === undefined) delete process.env.DB_PREFIX; else process.env.DB_PREFIX = saved;
  }
}

export function parseArgs(argv) {
  const o = { list: false, verify: false, apply: false, yes: false, all: false, drill: false, help: false, snap: undefined, to: undefined, skip: undefined };
  for (const a of argv) {
    if (a === '--list') o.list = true;
    else if (a === '--verify') o.verify = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--all') o.all = true;
    else if (a === '--drill') o.drill = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--snap=')) { o.snap = a.slice(7); if (!/^[0-9a-z][0-9a-z-]{3,39}$/.test(o.snap)) throw new Error('--snap: неверный номер копии'); }
    else if (a.startsWith('--to=')) { o.to = a.slice(5); if (o.to !== '' && !/^[A-Za-z0-9_-]{1,40}:?$/.test(o.to)) throw new Error('--to: допустимы буквы, цифры, «_» и «-» (до 40 символов)'); }
    else if (a.startsWith('--skip=')) { o.skip = a.slice(7).split(',').map((s) => s.trim()).filter(Boolean); if (o.skip.some((s) => !/^[a-z0-9_-]{1,20}$/i.test(s))) throw new Error('--skip: виды ключей через запятую, например rl,tgt'); }
    else throw new Error('неизвестный флаг: ' + a);
  }
  const modes = [o.list, o.verify, o.drill].filter(Boolean).length;
  if (modes > 1) throw new Error('--list, --verify и --drill взаимоисключающие');
  if ((o.list || o.verify) && (o.apply || o.to !== undefined || o.drill)) throw new Error('--list и --verify только читают: --apply и --to с ними не нужны');
  if (o.drill && (o.apply || o.to !== undefined || o.yes)) throw new Error('--drill сам выбирает одноразовый префикс и не требует --apply, --to, --yes');
  if (o.all && o.skip) throw new Error('--all и --skip несовместимы');
  return o;
}

const HELP = 'Использование: node scripts/restore-backup.mjs [--list | --verify | --drill] [--apply] [--snap=<номер>] [--to=<префикс>] [--all | --skip=a,b] [--yes]\nБез --apply сухой прогон. Подробности в начале файла.';

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  const io = {
    log: (s) => console.log(s),
    confirm: async (q, word) => {
      if (!process.stdin.isTTY) { console.log('Нет терминала для подтверждения: запустите в обычном окне PowerShell или добавьте --yes.'); return false; }
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return (await rl.question(q)).trim() === word; } finally { rl.close(); }
    },
  };
  const r = await run(o, io);
  if (!r.ok) process.exitCode = r.mode === 'cancelled' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('Ошибка: ' + (e && e.message || e)); process.exitCode = 1; });
}
