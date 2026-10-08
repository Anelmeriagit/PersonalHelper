// Разовая чистка: удаляет все аккаунты с паролем (владельца и Жанны; вход по паролю убран, гостевой режим, часть 3).
// По умолчанию СУХОЙ ПРОГОН: только считает, ничего не меняет.
//
// Запуск (PowerShell, из корня репозитория; значения переменных в файлы не писать, задавать только в окне):
//   $env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; $env:DB_PREFIX=''   # DB_PREFIX пуст = боевая база
//   node scripts/purge-pw.mjs                # сухой прогон: кого удалит
//   node scripts/purge-pw.mjs --apply        # применить (спросит подтверждение: ввести DELETE)
// Флаги: --apply (применить), --yes (не спрашивать подтверждение; только для автоматического запуска).
//
// Кто удаляется: запись acc:<id> с полем pw или nick и без gsub (аккаунты Google не трогаются никогда).
// Удаление идёт через deleteAccount (api/_acc.js): привязка Telegram, doc, rem, agent, wifi, bot, лимит привязки, nick:<никнейм>, счётчик users, в конце сама запись acc.
// Не трогаются: аккаунты Google, записи acc, которые не читаются как JSON (только считаются), ключи nick:*, у которых нет аккаунта (только считаются).
// Переменные окружения: KV_REST_API_URL, KV_REST_API_TOKEN (запасные UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN), DB_PREFIX.
// В вывод идут только числа и начало id (8 символов): ни адресов, ни токенов, ни никнеймов, ни содержимого записей.
import { pathToFileURL } from 'node:url';
import { cmd, pipe, key, prefix, dbReady } from '../api/_db.js';
import { CHUNK, short, globEsc, chunks, scan, ttyConfirm } from './_cli.mjs';
import { ID_RE, deleteAccount } from '../api/_acc.js';



// id из ключей <вид>:<id> этого префикса; ключи другого вида id (например acc:abc) считаются чужими.
async function idsOf(kind) {
  const head = prefix() + kind + ':';
  const ids = [];
  let foreign = 0;
  for (const k of await scan(globEsc(head) + '*')) {
    const rest = k.startsWith(head) ? k.slice(head.length) : '';
    if (ID_RE.test(rest)) ids.push(rest); else foreign++;
  }
  return { ids: ids.sort(), foreign };
}

// Разбор всех аккаунтов: { pw: [id], google: n, other: n (не читаются или ни пароля, ни Google), foreign: n }
export async function plan() {
  const { ids, foreign } = await idsOf('acc');
  const out = { pw: [], google: 0, other: 0, foreign, total: ids.length };
  for (const part of chunks(ids, CHUNK)) {
    const raws = await pipe(part.map((id) => ['GET', key('acc', id)]));
    part.forEach((id, i) => {
      let a = null;
      try { a = JSON.parse(raws[i]); } catch { /* не JSON */ }
      if (!a || typeof a !== 'object') out.other++;
      else if (a.gsub) out.google++; // аккаунт Google: даже с лишними полями не трогаем
      else if (a.pw || a.nick) out.pw.push(id);
      else out.other++;
    });
  }
  out.pw.sort();
  return out;
}

// Ключи nick:*, чей аккаунт уже удалён или не существует (после чистки их не должно быть; скрипт их не трогает, только считает).
async function orphanNicks() {
  const head = prefix() + 'nick:';
  const keys = await scan(globEsc(head) + '*');
  let n = 0;
  for (const part of chunks(keys, CHUNK)) {
    const ids = await pipe(part.map((k) => ['GET', k]));
    const ok = ids.filter((id) => ID_RE.test(String(id)));
    const ex = ok.length ? await pipe(ok.map((id) => ['EXISTS', key('acc', id)])) : [];
    n += ids.length - ok.length + ex.filter((e) => !Number(e)).length;
  }
  return { nicks: keys.length, orphan: n };
}

// io: { log(строка), confirm(вопрос) → Promise<bool> }
// → { plan, deleted, applied, skipped: [что не сделано] }
export async function run(opts, io) {
  const log = io.log;
  if (!dbReady()) throw new Error('Redis не настроен: задайте KV_REST_API_URL и KV_REST_API_TOKEN');
  const p = prefix();
  log((opts.apply ? 'РЕЖИМ: ПРИМЕНЕНИЕ' : 'РЕЖИМ: сухой прогон (ничего не меняется)') + '. Префикс ключей: ' + (p ? p : '(пусто: боевая база)'));

  const pl = await plan();
  log('  аккаунтов: ' + pl.total + ', с паролем: ' + pl.pw.length + ', Google: ' + pl.google + ', не читаются или без пароля и Google (не трогаем): ' + pl.other + (pl.foreign ? ', с другим видом id: ' + pl.foreign : ''));
  if (pl.pw.length) log('  к удалению (начало id): ' + pl.pw.map(short).join(', '));
  const on = await orphanNicks();
  log('  ключей nick: ' + on.nicks + (on.orphan ? ', из них без аккаунта: ' + on.orphan + ' (скрипт их не трогает)' : ''));

  if (!opts.apply) {
    log(pl.pw.length ? 'Сухой прогон завершён: ничего не изменено. Чтобы применить, добавьте --apply.' : 'Сухой прогон завершён: делать нечего.');
    return { plan: pl, deleted: 0, applied: false, skipped: [] };
  }
  if (!pl.pw.length) { log('Делать нечего.'); return { plan: pl, deleted: 0, applied: true, skipped: [] }; }

  if (!opts.yes) {
    const q = 'Будет удалено аккаунтов с паролем: ' + pl.pw.length + ' со всеми их данными' + (p ? '' : ' В БОЕВОЙ БАЗЕ') + '. Это необратимо. Введите DELETE: ';
    if (!(await io.confirm(q))) { log('Отменено: подтверждение не получено, ничего не изменено.'); return { plan: pl, deleted: 0, applied: false, skipped: [] }; }
  }

  let deleted = 0;
  const skipped = [];
  for (const id of pl.pw) {
    try {
      if (await deleteAccount(id)) { deleted++; log('  удалён ' + short(id)); } else log('  уже нет ' + short(id));
    } catch (e) {
      skipped.push(short(id));
      log('  ошибка ' + short(id) + ': ' + (e && e.name));
    }
  }
  const left = (await plan()).pw.length;
  log('  удалено ' + deleted + ', с паролем осталось ' + left);
  if (left) skipped.push('осталось ' + left);
  log(skipped.length ? 'Готово, но не всё: ' + skipped.join('; ') + '. Запустите ещё раз: повтор безопасен.' : 'Готово.');
  return { plan: pl, deleted, applied: true, skipped };
}

export function parseArgs(argv) {
  const o = { apply: false, yes: false, help: false };
  for (const a of argv) {
    if (a === '--apply') o.apply = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error('неизвестный флаг: ' + a);
  }
  return o;
}

const HELP = 'Использование: node scripts/purge-pw.mjs [--apply] [--yes]\nБез --apply сухой прогон. Подробности в начале файла.';

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  const io = {
    log: (s) => console.log(s),
    confirm: ttyConfirm,
  };
  const r = await run(o, io);
  if (r.skipped.length && o.apply) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('Ошибка: ' + (e && e.message || e)); process.exitCode = 1; });
}
