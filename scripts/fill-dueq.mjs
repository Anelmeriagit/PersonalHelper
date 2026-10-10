// Заполнение и перестройка индекса cron dueq в Redis (этап 5, переход на внешний планировщик, часть 3). По умолчанию СУХОЙ ПРОГОН: ничего не записывает.
// Нужен один раз перед включением частых внешних запусков (QStash, cron-job.org): без индекса /api/cron никого не найдёт. Потом индекс перестраивается сам:
// ежедневный вызов /api/cron?rebuild=1 (часть 4). Скрипт безопасно запускать повторно: он правит только отличия.
//
// Запуск (PowerShell, из корня репозитория; значения переменных в файлы не писать, задавать только в окне; нужен npm i):
//   $env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; $env:DB_PREFIX=''   # пусто = боевая база
//   node scripts/fill-dueq.mjs            # сухой прогон: сколько членов будет добавлено, изменено, убрано
//   node scripts/fill-dueq.mjs --apply    # записать (спросит подтверждение: REBUILD)
// Флаги: --yes (не спрашивать подтверждение; только для автоматического запуска), --help.
// Данные пользователей скрипт не меняет: пишет только ключ dueq (производный, восстанавливается из rem:/shr:). Убираются члены, у которых слать нечего или нет привязки Telegram.
// В вывод идут только числа: ни адресов, ни токенов, ни id аккаунтов.
import { pathToFileURL } from 'node:url';
import { dbReady, prefix } from '../api/_db.js';
import { ttyConfirm } from './_cli.mjs';
import { rebuildDue } from '../api/_reindex.js';

const BUDGET_MS = 10 * 60 * 1000; // у скрипта нет предела функции Vercel

const line = (r) => `аккаунтов с Telegram ${r.accounts}; в индексе было ${r.indexed}; добавить ${r.add}, изменить ${r.change}, убрать ${r.drop}, без изменений ${r.same}`;

export async function main(argv = process.argv.slice(2), io = { confirm: ttyConfirm, log: console.log }) {
  const { log } = io;
  if (argv.includes('--help')) { log('Использование: node scripts/fill-dueq.mjs [--apply] [--yes]; без --apply только сухой прогон (см. комментарий в начале файла).'); return 0; }
  if (!dbReady()) { log('Нужны KV_REST_API_URL и KV_REST_API_TOKEN (запасные UPSTASH_REDIS_REST_*).'); return 1; }
  const apply = argv.includes('--apply');
  const dry = await rebuildDue({ dry: true, budgetMs: BUDGET_MS });
  log((prefix() ? 'Префикс базы: ' + prefix() + '\n' : 'Боевая база (префикс пуст)\n') + 'Сухой прогон: ' + line(dry));
  if (dry.state !== 'ok') { log('Обход неполный (ошибки чтения: ' + dry.errors + '): ничего не записываем, повторите позже.'); return 1; }
  if (!apply) { log('Ничего не записано. Для записи добавьте --apply.'); return 0; }
  if (!dry.add && !dry.change && !dry.drop) { log('Индекс уже в порядке: записывать нечего.'); return 0; }
  if (!argv.includes('--yes') && !(await io.confirm('Записать изменения в индекс? Введите REBUILD: ', 'REBUILD'))) { log('Отменено, ничего не записано.'); return 1; }
  const r = await rebuildDue({ budgetMs: BUDGET_MS });
  log('Готово: ' + line(r) + (r.lost ? '; уже изменено запросами напоминаний ' + r.lost + ' (оставлено как есть)' : '') + '.');
  return r.state === 'ok' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().then((c) => { process.exitCode = c; }, (e) => { console.error('Ошибка:', e && (e.kind || e.name), e && e.message); process.exitCode = 1; });
