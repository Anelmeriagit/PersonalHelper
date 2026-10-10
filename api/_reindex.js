// Индекс dueq (см. _due.js): суточная перестройка и переиндексация одного аккаунта. Перестройку вызывает /api/cron?rebuild=1 и скрипт scripts/fill-dueq.mjs.
import { readRem, readShr, nextDueRem, nextDueShr, mskNow } from './_rem.js';
import { linkedIds, partnerAcc } from './_acc.js';
import { dueAll, dueLower, dueSetCmd, pairMember } from './_due.js';
import { pipe } from './_db.js';

const WORKERS = 8;
const short = (id) => String(id).slice(0, 8);
const chunks = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };

// Полная перестройка по множеству tgs (аккаунты с привязанным Telegram) и их парам. Считает счёт каждого члена заново и правит только отличия.
// Каждая правка идёт через dueSet: если счёт успели понизить запись напоминаний, он остаётся. Члены, которых перестройка не посетила (отвязанный
// аккаунт, удалённая пара, мусор), убираются только после полного обхода без ошибок: неполный обход ничего не стирает.
// dry — ничего не пишет. budgetMs — сколько времени отводится на чтение. → { state:'ok'|'partial', accounts, indexed, add, change, drop, same, lost, errors, ms }
export async function rebuildDue({ dry = false, budgetMs = 10000 } = {}) {
  const t0 = Date.now(), now = mskNow();
  const [cur, ids] = await Promise.all([dueAll(), linkedIds()]);
  const linked = new Set(ids);
  const want = new Map(); // член → счёт (null: слать нечего)
  const seen = new Set();
  let next = 0, errors = 0;
  const worker = async () => {
    for (;;) {
      if (Date.now() - t0 > budgetMs) return;
      const k = next++;
      if (k >= ids.length) return;
      const id = ids[k];
      try {
        want.set(id, nextDueRem((await readRem(id)).rem, now));
        const pr = await partnerAcc(id);
        const pm = pr ? pairMember(id, pr.id) : null;
        if (pm && !seen.has(pm)) {
          seen.add(pm);
          const [a, b] = id < pr.id ? [id, pr.id] : [pr.id, id];
          const sides = [linked.has(a) ? 'a' : '', linked.has(b) ? 'b' : ''].filter(Boolean);
          want.set(pm, sides.length ? nextDueShr((await readShr(a, b)).shr, now, sides) : null);
        }
      } catch (e) { errors++; console.error('rebuild failed', short(id), e && e.message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, ids.length) }, worker));
  const complete = next >= ids.length && errors === 0;
  const ops = []; // [член, прежний счёт, новый счёт]
  const st = { add: 0, change: 0, drop: 0, same: 0 };
  for (const [m, sc] of want) {
    const c = cur.has(m) ? cur.get(m) : null;
    if (sc === null) { if (c !== null) { st.drop++; ops.push([m, c, null]); } else st.same++; }
    else if (c === null) { st.add++; ops.push([m, null, sc]); }
    else if (c !== sc) { st.change++; ops.push([m, c, sc]); }
    else st.same++;
  }
  if (complete) for (const [m, c] of cur) if (!want.has(m)) { st.drop++; ops.push([m, c, null]); }
  let lost = 0;
  if (!dry) {
    for (const part of chunks(ops, 100)) {
      const res = await pipe(part.map((o) => dueSetCmd(o[0], o[1], o[2])));
      lost += res.filter((x) => Number(x) !== 1).length;
    }
  }
  return { state: complete ? 'ok' : 'partial', accounts: ids.length, indexed: cur.size, ...st, lost, errors, ms: Date.now() - t0 };
}

// Переиндексация одного аккаунта после привязки Telegram: его напоминания и общие пары могли ждать, пока Telegram не привязан (cron такие члены убирает).
// Только понижает счёт (ZADD LT), как записи напоминаний.
export async function reindexAccount(id) {
  const now = mskNow();
  const sc = nextDueRem((await readRem(id)).rem, now);
  if (sc !== null) await dueLower(id, sc);
  const pr = await partnerAcc(id);
  if (pr) {
    const sh = nextDueShr((await readShr(id, pr.id)).shr, now, ['a', 'b']);
    if (sh !== null) await dueLower(pairMember(id, pr.id), sh);
  }
}
