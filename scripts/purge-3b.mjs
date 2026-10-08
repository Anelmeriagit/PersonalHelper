// Разовая чистка данных этапа 3b и (по флагу) дополнение множества tgs. По умолчанию СУХОЙ ПРОГОН: только считает, ничего не меняет.
//
// Запуск (PowerShell, из корня репозитория; значения переменных в файлы не писать, задавать только в окне):
//   $env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; $env:DB_PREFIX=''   # DB_PREFIX пуст = боевая база
//   node scripts/purge-3b.mjs                         # сухой прогон: что будет удалено
//   node scripts/purge-3b.mjs --backfill              # + что попадёт в tgs
//   node scripts/purge-3b.mjs --apply --backfill      # применить (спросит подтверждение: ввести DELETE)
// Флаги: --apply (применить), --backfill (добавить в tgs аккаунты, привязанные в 3a), --only=rem,bot,doc,blob (что чистить; по умолчанию всё),
//        --yes (не спрашивать подтверждение; только для автоматического запуска).
//
// Что удаляется (все ключи с префиксом DB_PREFIX, только если после «вид:» стоит id аккаунта из 32 hex):
//   rem:<id>  — личные напоминания;  bot:<id> — состояние бота (псевдонимы, ожидающие запросы);  doc:<id> — документ кэшбэков (месяцы и свои категории);
//   Blob bot/state.json — общее состояние бота старой схемы (нужны BLOB_READ_WRITE_TOKEN и пакет @vercel/blob: npm i).
// Не трогаются: аккаунты (acc, nick, users), агент (agent), WiFi (wifi), привязка Telegram (tg, tgu, tgp, tgt), справочник банков (он в коде, не в базе).
// Переменные окружения: KV_REST_API_URL, KV_REST_API_TOKEN (запасные UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN), DB_PREFIX, BLOB_READ_WRITE_TOKEN.
// В вывод идут только числа и начало id (8 символов): ни адресов, ни токенов, ни содержимого записей.
import { pathToFileURL } from 'node:url';
import { cmd, pipe, key, prefix, dbReady } from '../api/_db.js';
import { CHUNK, short, globEsc, chunks, scan, ttyConfirm } from './_cli.mjs';
import { ID_RE } from '../api/_acc.js';

export const KINDS = ['rem', 'bot', 'doc', 'blob'];
export const BLOB_PATH = 'bot/state.json';
const REDIS_KINDS = ['rem', 'bot', 'doc'];



// id аккаунтов, у которых есть ключ <вид>:<id> в этом префиксе. Ключи не такого вида (например doc:abc) считаются чужими и не возвращаются.
export async function idsOf(kind) {
  const head = prefix() + kind + ':';
  const ids = [];
  let foreign = 0;
  for (const k of await scan(globEsc(head) + '*')) {
    const rest = k.startsWith(head) ? k.slice(head.length) : '';
    if (ID_RE.test(rest)) ids.push(rest); else foreign++;
  }
  return { ids: ids.sort(), foreign };
}

async function delKeys(keys) {
  let n = 0;
  for (const part of chunks(keys, CHUNK)) n += Number(await cmd('DEL', ...part)) || 0;
  return n;
}

// Аккаунты, привязанные в 3a, которых ещё нет в tgs. Берём только полную привязку (как accountOfTelegram и cron):
// tg:<id> с tid и chat, tgu:<tid> указывает на этот же аккаунт, сам аккаунт существует.
export async function backfillPlan() {
  const { ids } = await idsOf('tg');
  const members = new Set(((await cmd('SMEMBERS', key('tgs'))) || []).map(String));
  const add = [], have = [], skip = [];
  for (const part of chunks(ids, CHUNK)) {
    const raws = await pipe(part.map((id) => ['GET', key('tg', id)]));
    const ok = [];
    part.forEach((id, i) => {
      let l = null;
      try { l = JSON.parse(raws[i]); } catch { /* не JSON */ }
      if (!l || !l.tid || !l.chat || !/^\d{1,20}$/.test(String(l.tid))) skip.push([id, 'нет tid или chat']); else ok.push([id, String(l.tid)]);
    });
    if (!ok.length) continue;
    const res = await pipe(ok.flatMap(([id, tid]) => [['GET', key('tgu', tid)], ['EXISTS', key('acc', id)]]));
    ok.forEach(([id], i) => {
      if (res[2 * i] !== id) skip.push([id, 'tgu указывает не на этот аккаунт']);
      else if (!Number(res[2 * i + 1])) skip.push([id, 'аккаунта нет']);
      else (members.has(id) ? have : add).push(id);
    });
  }
  return { add, have, skip };
}

// Blob старой схемы: общий bot/state.json. Модуль @vercel/blob подключается при первом обращении: если пакет не установлен (npm i), шаг Blob пропускается.
async function blobPlan(io, log) {
  const mod = await io.blob();
  if (!mod) { log('  Blob: пропущено, пакет @vercel/blob не установлен (выполните npm i)'); return { state: 'nopkg', mod: null, targets: [] }; }
  if (!io.blobToken()) { log('  Blob: пропущено, не задана переменная BLOB_READ_WRITE_TOKEN'); return { state: 'notoken', mod, targets: [] }; }
  const r = await mod.list({ prefix: '' });
  const all = (r && r.blobs) || [];
  const targets = all.filter((b) => b.pathname === BLOB_PATH);
  const rest = all.filter((b) => b.pathname !== BLOB_PATH).map((b) => b.pathname);
  log('  Blob ' + BLOB_PATH + ': ' + (targets.length ? 'найден' : 'нет'));
  if (rest.length) log('  Blob, останется (скрипт не трогает): ' + rest.slice(0, 10).join(', ') + (rest.length > 10 ? ' и ещё ' + (rest.length - 10) : ''));
  return { state: 'ok', mod, targets };
}

// io: { log(строка), confirm(вопрос) → Promise<bool>, blob() → модуль | null, blobToken() → строка }
// → { plan: {rem, bot, doc, blob, add}, deleted: {...}, applied, skipped: [что не сделано] }
export async function run(opts, io) {
  const log = io.log;
  const only = (opts.only && opts.only.length ? opts.only : KINDS);
  if (!dbReady()) throw new Error('Redis не настроен: задайте KV_REST_API_URL и KV_REST_API_TOKEN');
  const p = prefix();
  log((opts.apply ? 'РЕЖИМ: ПРИМЕНЕНИЕ' : 'РЕЖИМ: сухой прогон (ничего не меняется)') + '. Префикс ключей: ' + (p ? p : '(пусто: боевая база)'));

  const plan = {}, skipped = [];
  for (const k of REDIS_KINDS) {
    if (!only.includes(k)) continue;
    const r = await idsOf(k);
    plan[k] = r.ids;
    log('  ' + k + ': ключей ' + r.ids.length + (r.foreign ? ' (ещё ' + r.foreign + ' с другим видом id, их не трогаем)' : ''));
  }
  let blob = null;
  if (only.includes('blob')) { blob = await blobPlan(io, log); plan.blob = blob.targets.length; if (blob.state !== 'ok') skipped.push('Blob'); }
  let bf = null;
  if (opts.backfill) {
    bf = await backfillPlan();
    plan.add = bf.add;
    log('  tgs: добавить ' + bf.add.length + ', уже есть ' + bf.have.length + ', пропущено ' + bf.skip.length);
    for (const [id, why] of bf.skip) log('    пропуск ' + short(id) + ': ' + why);
  }

  const total = REDIS_KINDS.reduce((n, k) => n + (plan[k] ? plan[k].length : 0), 0) + (blob ? blob.targets.length : 0);
  const todo = total + (bf ? bf.add.length : 0);
  if (!opts.apply) {
    log(todo ? 'Сухой прогон завершён: ничего не изменено. Чтобы применить, добавьте --apply.' : 'Сухой прогон завершён: делать нечего.');
    return { plan, deleted: {}, applied: false, skipped };
  }
  if (!todo) { log('Делать нечего.'); return { plan, deleted: {}, applied: true, skipped }; }

  if (!opts.yes) {
    const q = 'Будет удалено ключей: ' + total + (bf ? ', добавлено в tgs: ' + bf.add.length : '') + (p ? '' : ' В БОЕВОЙ БАЗЕ') + '. Это необратимо. Введите DELETE: ';
    if (!(await io.confirm(q))) { log('Отменено: подтверждение не получено, ничего не изменено.'); return { plan, deleted: {}, applied: false, skipped }; }
  }

  const deleted = {};
  for (const k of REDIS_KINDS) {
    if (!plan[k]) continue;
    deleted[k] = await delKeys(plan[k].map((id) => key(k, id)));
    const left = (await idsOf(k)).ids.length;
    log('  ' + k + ': удалено ' + deleted[k] + ', осталось ' + left);
    if (left) skipped.push(k + ' (осталось ' + left + ')');
  }
  if (blob && blob.targets.length) {
    await blob.mod.del(blob.targets.map((b) => b.url || b.pathname));
    const left = ((await blob.mod.list({ prefix: BLOB_PATH })).blobs || []).filter((b) => b.pathname === BLOB_PATH).length;
    deleted.blob = blob.targets.length - left;
    log('  Blob ' + BLOB_PATH + ': удалён, осталось ' + left);
    if (left) skipped.push('Blob (осталось ' + left + ')');
  }
  if (bf && bf.add.length) {
    let n = 0;
    for (const part of chunks(bf.add, CHUNK)) n += Number(await cmd('SADD', key('tgs'), ...part)) || 0;
    deleted.added = n;
    log('  tgs: добавлено ' + n);
  }
  log(skipped.length ? 'Готово, но не всё: ' + skipped.join('; ') : 'Готово.');
  return { plan, deleted, applied: true, skipped };
}

export function parseArgs(argv) {
  const o = { apply: false, backfill: false, yes: false, only: null, help: false };
  for (const a of argv) {
    if (a === '--apply') o.apply = true;
    else if (a === '--backfill') o.backfill = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--only=')) {
      o.only = a.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
      const bad = o.only.filter((k) => !KINDS.includes(k));
      if (bad.length || !o.only.length) throw new Error('--only: допустимо ' + KINDS.join(', ') + (bad.length ? '; неизвестно: ' + bad.join(', ') : ''));
    } else throw new Error('неизвестный флаг: ' + a);
  }
  return o;
}

const HELP = 'Использование: node scripts/purge-3b.mjs [--apply] [--backfill] [--only=rem,bot,doc,blob] [--yes]\nБез --apply сухой прогон. Подробности в начале файла.';

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  const io = {
    log: (s) => console.log(s),
    confirm: ttyConfirm,
    blob: async () => { try { return await import('@vercel/blob'); } catch { return null; } },
    blobToken: () => process.env.BLOB_READ_WRITE_TOKEN || '',
  };
  const r = await run(o, io);
  if (r.skipped.length && o.apply) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('Ошибка: ' + (e && e.message || e)); process.exitCode = 1; });
}
