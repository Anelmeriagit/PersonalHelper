// Индекс «кому пора слать» (этап 5, переход на внешний планировщик, часть 3). Ключ Redis dueq (с префиксом DB_PREFIX): отсортированное множество,
// член — id аккаунта (личные напоминания rem:<id>) или p:<меньший id>:<больший id> (общие напоминания пары shr:…), счёт — время в мс (UTC) ближайшей отправки.
// Инвариант: счёт не больше настоящего ближайшего времени (лишняя запись безвредна: cron разберёт её и уточнит счёт, а вот пропавшая или завышенная —
// потерянное напоминание). Поэтому записи в базу (mutateRem, mutateShr) только понижают счёт (ZADD LT) и никогда не повышают и не удаляют;
// повышает и удаляет cron после обработки (dueSet: меняет счёт, только если он не менялся с момента чтения) и суточная перестройка (_reindex.js).
// Здесь только команды Redis, без расписания: файл ничего не знает о напоминаниях и не импортирует их модули (их импортируют _rem.js и _acc.js).
import { cmd, key } from './_db.js';

const ID = /^[0-9a-f]{32}$/;
export const pairMember = (a, b) => 'p:' + (a < b ? a + ':' + b : b + ':' + a);
// → { kind:'acc', id } | { kind:'pair', a, b } (a — меньший id) | null (мусор)
export function parseMember(m) {
  const s = String(m);
  if (ID.test(s)) return { kind: 'acc', id: s };
  const x = /^p:([0-9a-f]{32}):([0-9a-f]{32})$/.exec(s);
  return x && x[1] < x[2] ? { kind: 'pair', a: x[1], b: x[2] } : null;
}

// Уточнить счёт, только если он не менялся с момента чтения (атомарно): expect — прежний счёт (null — члена не было), to — новый (null — убрать).
// Если счёт успели понизить (запись напоминаний), он остаётся: этот член разберёт следующий запуск.
export const DUE_SET = `-- dueset
local cur = redis.call('ZSCORE', KEYS[1], ARGV[1])
if cur then cur = tonumber(cur) else cur = nil end
if cur ~= tonumber(ARGV[2]) then return 0 end
if ARGV[3] == '' then
  if cur then redis.call('ZREM', KEYS[1], ARGV[1]) end
else
  redis.call('ZADD', KEYS[1], tonumber(ARGV[3]), ARGV[1])
end
return 1`;
const num = (v) => (v === null || v === undefined ? '' : String(Math.round(v)));
export const dueSetCmd = (member, expect, to) => ['EVAL', DUE_SET, 1, key('dueq'), member, num(expect), num(to)];
export async function dueSet(member, expect, to) { return Number(await cmd(...dueSetCmd(member, expect, to))) === 1; }

// Понизить счёт (или добавить члена): ZADD LT. Чужую запись не перетирает.
export const dueLower = (member, ms) => cmd('ZADD', key('dueq'), 'LT', Math.round(ms), member);
// Убрать членов (данные удалены: аккаунт, связь пары).
export const dueDrop = (...members) => (members.length ? cmd('ZREM', key('dueq'), ...members) : 0);

const pairs = (r) => { const o = []; for (let i = 0; Array.isArray(r) && i + 1 < r.length; i += 2) o.push({ m: String(r[i]), s: Number(r[i + 1]) }); return o; };
// Члены со счётом не больше maxMs, по возрастанию счёта, не больше limit. → [{ m, s }]
export const dueRange = async (maxMs, limit) => pairs(await cmd('ZRANGEBYSCORE', key('dueq'), '-inf', Math.round(maxMs), 'WITHSCORES', 'LIMIT', 0, limit));
// Весь индекс (для суточной перестройки). → Map(член → счёт)
export async function dueAll() { const m = new Map(); for (const x of pairs(await cmd('ZRANGE', key('dueq'), 0, -1, 'WITHSCORES'))) m.set(x.m, x.s); return m; }
