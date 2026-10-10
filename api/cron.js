// Рассылка личных и общих напоминаний (этап 3b; общие пары — этап 5, «Соединить аккаунты», часть 4) и ежедневная резервная копия Redis (этап 4.3, см. notes/backup.md).
// Кому пора, читается из индекса dueq (этап 5, переход на внешний планировщик, часть 3; _due.js): члены со счётом не больше текущего времени → rem:<id> / shr:<id>:<id> → отправка в tg:<id>.chat.
// Без индекса (прежний обход всего множества tgs) каждый запуск стоил бы около 2 команд Redis на аккаунт. После обработки счёт члена уточняется (dueSet) или член убирается; раз в сутки
// ?rebuild=1 перестраивает индекс по tgs (_reindex.js). Запись напоминаний только понижает счёт, поэтому пропущенное в индексе возможно лишь при сбое Redis между двумя командами записи.
// Запуск по текущему времени (этап 5, переход на внешний планировщик, часть 2): каждый вызов берёт час по Москве и шлёт всё, чей час уже наступил и что не помечено
// (догоняем в тот же день). Вызывает внешний планировщик (QStash, запасной cron-job.org) и ежедневный cron Vercel; план — notes/reminders.md.
// ?role=primary (по умолчанию) — основной, ставит пульс cron:hb; ?role=backup — запасной: если основной сработал меньше 15 минут назад, пропускает запуск
// ({skipped:'primary alive'}), иначе берёт рассылку сам (took_over:true). Замок cron:lock (SET NX PX 30 с): два запуска не идут одновременно, занято — 200 {busy:true}.
// ?slot=h15 (или day/evening) — ручной запуск ровно одного слота независимо от времени суток; ?dry=1 — сухой прогон; ?rebuild=1 — перед рассылкой перестроить индекс (не зависит от role и пульса:
// суточный вызов Vercel не должен пропускать перестройку, когда основной жив).
// Лимиты: общий поток Telegram около 30 сообщений в секунду (шлём не чаще 20), maxDuration функции 30 с (укладываемся в BUDGET_MS).
// Отметка «отправлено» ставится до отправки (planRem), поэтому повторный запуск не дублирует; не успевшие аккаунты (left) и сбои добираются повторным вызовом.
// Общие напоминания (shr:<id>:<id>): у каждого аккаунта своя галочка и своя отметка отправки, поэтому каждый аккаунт пары при своём обходе забирает только свою сторону
// и получает сообщение в свой Telegram; без привязки Telegram ничего не помечается (отметка стороны остаётся пустой).
// Копия: после рассылки, на оставшееся время (всего 30 с), в оба слота: backupIfDue делает новую копию, только если последней полной больше 7 суток (DUE_GAP_MS),
// и продолжает незаконченную (до 3 суток, STALE_MS). Поэтому сбой или нехватка времени в одном слоте доделываются следующим. Копия не мешает рассылке: её сбой не
// отменяет отправленное, а только даёт код 502. Ручной запуск только копии: /api/cron?backup=1 (без рассылки; &dry=1 — только состояние).
// Нет BACKUP_KEY — копия выключена (state:'off'), рассылка работает как раньше. Ключ задан, но негодный (не 64 hex-символа, слишком простой) —
// это ошибка настройки (state:'error', kind:'config', код 502), а не тихое отключение: опечатка не должна оставлять базу без копий.
import { authed, sendCustom } from './_bot.js';
import { mskNow, SLOT_HOUR, LAST_HOUR, readRem, mutateRem, planRem, unclaimRem, readShr, mutateShr, planShr, unclaimShr, sideOf, nextDueRem, nextDueShr, dayEndMs } from './_rem.js';
import { dueRange, dueSet, parseMember } from './_due.js';
import { rebuildDue } from './_reindex.js';
import { getLink, partnerAcc } from './_acc.js';
import { cmd, key, lock, unlock, del } from './_db.js';
import { backupReady, backupStatus, backupIfDue, runBackup, DUE_GAP_MS } from './_backup.js';

const BUDGET_MS = 24000; // из 30 с maxDuration: запас на последнюю отправку и ответ
const GAP_MS = 50; // между любыми двумя отправками
const WORKERS = 8; // аккаунтов читается параллельно (запросы к Redis), отправки идут общей очередью
const TOTAL_MS = 30000; // maxDuration из vercel.json
const BACKUP_BUDGET_MS = 20000; // сколько копия обходит базу за вызов
const BACKUP_TAIL_MS = 8000; // запас после обхода: последняя часть, манифест, ротация, ответ
const BACKUP_MIN_MS = 3000; // меньше этого времени копию не начинаем (доделает следующий слот)
const LOCK_MS = 30000; // замок cron:lock (равен maxDuration; снимается в конце запуска)
const HB_FRESH_MS = 15 * 60 * 1000; // основной считается живым, если сработал не позже
const HB_TTL_MS = 3 * 24 * 3600 * 1000; // пульс хранится 3 суток (для поля last)
const BK_GAP_MS = 6 * 3600 * 1000; // проверка «пора ли копию» не чаще раза в 6 часов (список Blob считается дорогой операцией); незаконченная копия снимает отметку
const DUE_LIMIT = 600; // сколько членов индекса берёт один запуск (остальные — следующим: в ответе left)
const REBUILD_MS = 10000; // сколько времени отводится на перестройку индекса (?rebuild=1); остаток идёт на рассылку
const DEAD = /blocked|deactivated|chat not found|kicked/i; // человек заблокировал бота или удалил чат: повторять бессмысленно

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Очередь отправок: каждый вызов получает своё время (с шагом gap) и ждёт его. Бронирование синхронное, поэтому параллельные вызовы не пересекаются.
function makePacer(gap) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await sleep(at - now);
  };
}

const short = (id) => String(id).slice(0, 8); // в журнал только начало id

// 'off' — переменная не задана или пуста; 'bad' — задана, но backupKey() её не примет; 'ok'.
const keyState = () => (!String(process.env.BACKUP_KEY || '').trim() ? 'off' : backupReady() ? 'ok' : 'bad');

// Копия на оставшееся время. force — ручной запуск (делает копию, не глядя на давность последней). → объект для ответа: только числа и слова.
async function backupStep(t0, force) {
  const ks = keyState();
  if (ks === 'off') return { state: 'off' };
  if (ks === 'bad') { console.error('backup failed: BACKUP_KEY задан, но негоден'); return { state: 'error', kind: 'config' }; }
  const budgetMs = Math.min(BACKUP_BUDGET_MS, TOTAL_MS - (Date.now() - t0) - BACKUP_TAIL_MS);
  if (budgetMs < BACKUP_MIN_MS) return { state: 'skipped', reason: 'time' };
  const gk = key('cron', 'bk');
  if (!force && (await cmd('SET', gk, '1', 'NX', 'PX', BK_GAP_MS)) !== 'OK') return { state: 'skipped', reason: 'recent' };
  const t1 = Date.now();
  try {
    const r = await (force ? runBackup : backupIfDue)({ budgetMs });
    if (!force && r.state === 'partial') await del(gk).catch(() => {}); // продолжит следующий запуск
    const out = { state: r.state, ms: Date.now() - t1 };
    for (const k of ['snap', 'parts', 'keys', 'bytes', 'pruned', 'lastAt']) if (r[k] !== undefined) out[k] = r[k];
    if (r.stats) out.stats = r.stats; // scanned, copied, gone, changed, foreign, other
    return out;
  } catch (e) {
    console.error('backup failed', e && (e.kind || e.name), e && e.message);
    return { state: 'error', kind: (e && (e.kind || e.name)) || 'failed' };
  }
}

// Состояние копий для сухого прогона: без расшифровки и без записи.
async function backupInfo() {
  const ks = keyState();
  if (ks === 'off') return { state: 'off' };
  if (ks === 'bad') return { state: 'error', kind: 'config' };
  try {
    const st = await backupStatus();
    return { state: 'on', blob: !!process.env.BLOB_READ_WRITE_TOKEN, copies: st.copies, last: st.lastAt ? new Date(st.lastAt).toISOString() : null, running: st.running, due: !st.running && (!st.lastAt || Date.now() - st.lastAt >= DUE_GAP_MS) };
  } catch (e) {
    console.error('backup status failed', e && (e.kind || e.name), e && e.message);
    return { state: 'error', kind: (e && (e.kind || e.name)) || 'failed' };
  }
}

// Один аккаунт: свои напоминания (w.own) и общие пары (w.shr, его сторона), в зависимости от того, чем он записан в индексе. → { n: сколько ушло (при dry: ушло бы), failed, blocked, nolink }
// Лишние команды Redis: у не соединённого аккаунта одна (GET pair:<id> в partnerAcc), у соединённого ещё три на проверку пары и одна на чтение общей записи.
// Личный член индекса уточняется здесь же (счёт w.s был прочитан вместе со списком): dueSet не тронет его, если запись успели изменить. Член пары уточняется после всех аккаунтов (settlePair).
const clone = (o) => JSON.parse(JSON.stringify(o));
async function one(id, now, slot, dry, turn, w) {
  let rem = null, plan = [];
  if (w.own) { rem = (await readRem(id)).rem; plan = planRem(clone(rem), now, slot); } // пробный расчёт на копии: ничего не меняет
  let pr = null, splan = [];
  if (w.shr) { pr = await partnerAcc(id); if (pr) splan = planShr(clone((await readShr(id, pr.id)).shr), now, slot, sideOf(id, pr.id)); } // общие читаем только у полной пары
  const settle = async (fresh) => { if (w.own && !dry) await dueSet(id, w.s, fresh === null ? null : nextDueRem(fresh, now)); };
  if (!plan.length && !splan.length) { await settle(rem); return { n: 0, failed: 0, blocked: 0 }; }
  const link = await getLink(id);
  if (!link || !link.chat) { await settle(null); return { n: 0, failed: 0, blocked: 0, nolink: true }; } // привязку убрали: ничего не помечаем, член индекса убираем (привязка вернёт его: reindexAccount)
  if (dry) return { n: plan.length + splan.length, failed: 0, blocked: 0 };
  let claims = [], sclaims = [];
  // Отметки ставятся без записи в индекс (due:false): счёт уточняется ниже по свежим данным. При повторе из-за чужой записи fn вызывается заново на свежих данных.
  if (plan.length) await mutateRem(id, (r) => { claims = planRem(r, now, slot); }, { due: false });
  if (splan.length) await mutateShr(id, pr.id, (r, me) => { sclaims = planShr(r, now, slot, me); }, { due: false });
  const fails = [], sfails = [];
  let n = 0, blocked = 0;
  for (const c of claims.concat(sclaims)) {
    await turn();
    try { await sendCustom(link.chat, c.text); n++; }
    catch (e) {
      if (DEAD.test(String(e && e.message))) blocked++; // отметка остаётся: после блокировки повтор не нужен
      else { (c.shared ? sfails : fails).push(c); console.error('send failed', short(id), e && e.message); }
    }
  }
  if (fails.length) {
    try { await mutateRem(id, (r) => { unclaimRem(r, fails); }); } catch (e) { console.error('unclaim failed', short(id), e && e.message); } // с записью в индекс: неудавшееся снова «пора»
  }
  if (sfails.length) {
    try { await mutateShr(id, pr.id, (r, me) => { unclaimShr(r, sfails, me); }); } catch (e) { console.error('unclaim shared failed', short(id), e && e.message); }
  }
  await settle(w.own ? (await readRem(id)).rem : null);
  return { n, failed: fails.length + sfails.length, blocked };
}

// Член-пара индекса после обработки: счёт по свежей общей записи и только по сторонам с привязанным Telegram (у стороны без привязки ничего не отправить,
// иначе член оставался бы «пора» навсегда). Нет сторон или слать нечего — член убирается; привязка (reindexAccount) и запись напоминаний вернут его.
async function settlePair(p, now) {
  const [{ shr }, la, lb] = await Promise.all([readShr(p.a, p.b), getLink(p.a), getLink(p.b)]);
  const sides = [la && la.chat ? 'a' : '', lb && lb.chat ? 'b' : ''].filter(Boolean);
  await dueSet(p.m, p.s, sides.length ? nextDueShr(shr, now, sides) : null);
}

export default async function handler(req, res) {
  const t0 = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  if (!authed(req)) return res.status(401).json({ error: 'auth' });
  const q = req.query || {};
  if (q.send) return res.status(400).json({ error: 'send removed' }); // тестовая отправка постоянных убрана вместе с ними; старый адрес не должен запускать рассылку
  try {
    // Сухой прогон: /api/cron?dry=1[&slot=evening][&date=2026-10-25] (заголовок Authorization: Bearer <CRON_SECRET>): ничего не отправляет и не пишет.
    // В ответе только числа: ни id аккаунтов, ни текстов.
    const dry = q.dry === '1';
    // Только копия: /api/cron?backup=1 (рассылку не трогает; незаконченную копию продолжает, иначе начинает новую). Ответ 400, если BACKUP_KEY не задан.
    if (q.backup === '1') {
      if (dry) return res.status(200).json({ dry: true, backup: await backupInfo() });
      const b = await backupStep(t0, true);
      return res.status(b.state === 'error' ? 502 : b.state === 'off' ? 400 : 200).json({ backup: b });
    }
    let now = mskNow();
    if (q.date) {
      if (!dry) return res.status(400).json({ error: 'date работает только с dry=1' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date)) return res.status(400).json({ error: 'date: YYYY-MM-DD' });
      now = { month: q.date.slice(0, 7), date: q.date }; // без часа: весь день
    }
    // Ручной запуск одного слота: ?slot=h15 | day | evening (ровно этот час, время суток не смотрим). Без slot — всё, чей час уже наступил.
    if (q.slot !== undefined && !Object.prototype.hasOwnProperty.call(SLOT_HOUR, q.slot)) return res.status(400).json({ error: 'slot: h07…h23, day, evening' });
    const slot = q.slot;
    const role = q.role === undefined ? 'primary' : q.role;
    if (role !== 'primary' && role !== 'backup') return res.status(400).json({ error: 'role: primary|backup' });

    // Перестройка индекса dueq (раз в сутки: ежедневный вызов Vercel с ?role=backup&rebuild=1). Идёт до пульса и замка рассылки и не зависит от того, пропустят ли
    // запуск ниже: основной жив, а индекс всё равно надо проверить. Свой замок cron:rb (60 с) не даёт двум перестройкам идти одновременно; сухой прогон ничего не пишет.
    let rebuild = null;
    if (q.rebuild === '1') {
      const rk = key('cron', 'rb');
      const rt = dry ? null : await lock(rk, 60000);
      if (!dry && !rt) rebuild = { state: 'busy' };
      else {
        try { rebuild = await rebuildDue({ dry, budgetMs: REBUILD_MS }); }
        catch (e) { console.error('rebuild failed', e && (e.kind || e.name), e && e.message); rebuild = { state: 'error', kind: (e && (e.kind || e.name)) || 'failed' }; }
        finally { if (rt) await unlock(rk, rt).catch((e) => console.error('unlock failed', e && e.message)); }
      }
    }
    const rbBad = !!rebuild && (rebuild.state === 'error' || rebuild.state === 'partial'); // перестройка не закончена: 502, чтобы это заметили

    // Пульс: когда в последний раз сработал основной. Запасной при живом основном ничего не делает; иначе берёт рассылку сам.
    const hbk = key('cron', 'hb');
    const hb = Number(await cmd('GET', hbk)) || 0;
    const last = hb ? new Date(hb).toISOString() : null;
    const info = { role, took_over: role === 'backup', last };
    if (role === 'backup' && hb && Date.now() - hb < HB_FRESH_MS) return res.status(rbBad ? 502 : 200).json({ ...(dry ? { dry: true } : {}), skipped: 'primary alive', ...info, took_over: false, ...(rebuild ? { rebuild } : {}) });
    if (!dry && role === 'primary' && !slot) await cmd('SET', hbk, Date.now(), 'PX', HB_TTL_MS); // ручной запуск слота пульсом не считается

    // Замок: рассылка и копия не идут одновременно в двух запусках. Сухой прогон ничего не пишет и замок не берёт.
    const lk = key('cron', 'lock');
    const token = dry ? null : await lock(lk, LOCK_MS);
    if (!dry && !token) return res.status(rbBad ? 502 : 200).json({ busy: true, ...info, ...(rebuild ? { rebuild } : {}) });
    try {
      // Кому пора: члены индекса со счётом не больше текущего времени. Ручной слот и сухой прогон с date смотрят до конца московских суток (слот или день, а не «сейчас»).
      const cutoff = slot || (dry && q.date) ? dayEndMs(now.date) : Date.now();
      const got = await dueRange(cutoff, DUE_LIMIT + 1);
      const more = got.length > DUE_LIMIT;
      const want = new Map(); // id аккаунта → { own: есть личный член, shr: есть член пары, s: счёт личного члена }
      const pairs = [];
      let junk = 0;
      for (const e of got.slice(0, DUE_LIMIT)) {
        const p = parseMember(e.m);
        if (!p) { junk++; if (!dry) await dueSet(e.m, e.s, null).catch(() => {}); continue; } // не наш член: убираем
        const ids2 = p.kind === 'acc' ? [p.id] : [p.a, p.b];
        for (const id of ids2) { if (!want.has(id)) want.set(id, { own: false, shr: false, s: 0 }); }
        if (p.kind === 'acc') { const w = want.get(p.id); w.own = true; w.s = e.s; }
        else { want.get(p.a).shr = true; want.get(p.b).shr = true; pairs.push({ a: p.a, b: p.b, m: e.m, s: e.s }); }
      }
      const ids = [...want.keys()].sort();
      const turn = makePacer(GAP_MS);
      const deadline = t0 + BUDGET_MS;
      const st = { accounts: ids.length, sent: 0, failed: 0, blocked: 0, nolink: 0, errors: 0 };
      let next = 0;
      const worker = async () => {
        for (;;) {
          if (Date.now() > deadline) return;
          const k = next++;
          if (k >= ids.length) return;
          try {
            const r = await one(ids[k], now, slot, dry, turn, want.get(ids[k]));
            st.sent += r.n; st.failed += r.failed; st.blocked += r.blocked; if (r.nolink) st.nolink++;
          } catch (e) { st.errors++; console.error('account failed', short(ids[k]), e && e.message); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(WORKERS, ids.length) }, worker));
      if (!dry) {
        for (const p of pairs) {
          try { await settlePair(p, now); } catch (e) { st.errors++; console.error('pair settle failed', short(p.a), e && e.message); }
        }
      }
      const left = Math.max(0, ids.length - next) + (more ? 1 : 0);
      const when = { date: now.date, ...(now.hour !== undefined ? { hour: now.hour } : {}), ...(slot ? { slot } : {}) };
      const extra = { due: got.length - (more ? 1 : 0) - junk, ...(junk ? { junk } : {}), ...(rebuild ? { rebuild } : {}) };
      if (dry) return res.status(rbBad ? 502 : 200).json({ dry: true, ...when, ...info, ...extra, accounts: st.accounts, would_send: st.sent, nolink: st.nolink, errors: st.errors, left, backup: await backupInfo() });
      const backup = await backupStep(t0, false);
      // Последний запуск дня (час 23) не успел дописать копию: следующая попытка только завтра утром, поэтому 502. Раньше её доделает следующий запуск.
      const backupBad = backup.state === 'error' || (backup.state === 'partial' && now.hour >= LAST_HOUR);
      return res.status(st.failed || st.errors || left || backupBad || rbBad ? 502 : 200).json({ ...when, ...info, ...extra, ...st, left, backup });
    } finally {
      if (token) await unlock(lk, token).catch((e) => console.error('unlock failed', e && e.message));
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'failed', message: e.message });
  }
}
