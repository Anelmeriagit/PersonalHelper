// Рассылка личных напоминаний (этап 3b) и ежедневная резервная копия Redis (этап 4.3, см. notes/backup.md). Обход: множество tgs (аккаунты с привязанным Telegram, см. _acc.js) → rem:<id> → отправка в tg:<id>.chat.
// Hobby: cron раз в сутки, два слота (vercel.json: 11:00 UTC — «day», 15:00 UTC — «evening»). Точное время отправки сервер не гарантирует.
// Лимиты: общий поток Telegram около 30 сообщений в секунду (шлём не чаще 20), maxDuration функции 30 с (укладываемся в BUDGET_MS).
// Отметка «отправлено» ставится до отправки (planRem), поэтому повторный запуск не дублирует; не успевшие аккаунты (left) и сбои добираются повторным вызовом.
// Копия: после рассылки, на оставшееся время (всего 30 с), в оба слота: backupIfDue делает новую копию, только если последней полной больше 20 часов,
// и продолжает незаконченную. Поэтому сбой или нехватка времени в дневном слоте доделываются вечерним. Копия не мешает рассылке: её сбой не
// отменяет отправленное, а только даёт код 502. Ручной запуск только копии: /api/cron?backup=1 (без рассылки; &dry=1 — только состояние).
// Нет BACKUP_KEY — копия выключена (state:'off'), рассылка работает как раньше. Ключ задан, но негодный (не 64 hex-символа, слишком простой) —
// это ошибка настройки (state:'error', kind:'config', код 502), а не тихое отключение: опечатка не должна оставлять базу без копий.
import { authed, sendCustom } from './_bot.js';
import { mskNow, readRem, mutateRem, planRem, unclaimRem } from './_rem.js';
import { linkedIds, getLink } from './_acc.js';
import { backupReady, backupStatus, backupIfDue, runBackup, DUE_GAP_MS } from './_backup.js';

const BUDGET_MS = 24000; // из 30 с maxDuration: запас на последнюю отправку и ответ
const GAP_MS = 50; // между любыми двумя отправками
const WORKERS = 8; // аккаунтов читается параллельно (запросы к Redis), отправки идут общей очередью
const TOTAL_MS = 30000; // maxDuration из vercel.json
const BACKUP_BUDGET_MS = 20000; // сколько копия обходит базу за вызов
const BACKUP_TAIL_MS = 8000; // запас после обхода: последняя часть, манифест, ротация, ответ
const BACKUP_MIN_MS = 3000; // меньше этого времени копию не начинаем (доделает следующий слот)
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
  const t1 = Date.now();
  try {
    const r = await (force ? runBackup : backupIfDue)({ budgetMs });
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

// Один аккаунт. → { n: сколько ушло (при dry: ушло бы), failed, blocked, nolink }
async function one(id, now, slot, dry, turn) {
  const { rem } = await readRem(id);
  const plan = planRem(JSON.parse(JSON.stringify(rem)), now, slot); // пробный расчёт на копии: ничего не меняет
  if (!plan.length) return { n: 0, failed: 0, blocked: 0 };
  const link = await getLink(id);
  if (!link || !link.chat) return { n: 0, failed: 0, blocked: 0, nolink: true }; // привязку убрали: ничего не помечаем
  if (dry) return { n: plan.length, failed: 0, blocked: 0 };
  let claims = [];
  await mutateRem(id, (r) => { claims = planRem(r, now, slot); }); // при повторе из-за чужой записи fn вызывается заново на свежих данных
  const fails = [];
  let n = 0, blocked = 0;
  for (const c of claims) {
    await turn();
    try { await sendCustom(link.chat, c.text); n++; }
    catch (e) {
      if (DEAD.test(String(e && e.message))) blocked++; // отметка остаётся: после блокировки повтор не нужен
      else { fails.push(c); console.error('send failed', short(id), e && e.message); }
    }
  }
  if (fails.length) {
    try { await mutateRem(id, (r) => { unclaimRem(r, fails); }); } catch (e) { console.error('unclaim failed', short(id), e && e.message); }
  }
  return { n, failed: fails.length, blocked };
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
      now = { month: q.date.slice(0, 7), date: q.date };
    }
    // Два запуска в сутки: «day» (14:00–15:00 МСК) и «evening» (18:00–19:00 МСК, /api/cron?slot=evening); сухой прогон без slot смотрит оба.
    const slot = dry && !q.slot ? undefined : q.slot === 'evening' ? 'evening' : 'day';

    const ids = await linkedIds();
    const turn = makePacer(GAP_MS);
    const deadline = Date.now() + BUDGET_MS;
    const st = { accounts: ids.length, sent: 0, failed: 0, blocked: 0, nolink: 0, errors: 0 };
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (Date.now() > deadline) return;
        const k = next++;
        if (k >= ids.length) return;
        try {
          const r = await one(ids[k], now, slot, dry, turn);
          st.sent += r.n; st.failed += r.failed; st.blocked += r.blocked; if (r.nolink) st.nolink++;
        } catch (e) { st.errors++; console.error('account failed', short(ids[k]), e && e.message); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, ids.length) }, worker));
    const left = Math.max(0, ids.length - next);
    if (dry) return res.status(200).json({ dry: true, date: now.date, accounts: st.accounts, would_send: st.sent, nolink: st.nolink, errors: st.errors, left, backup: await backupInfo() });
    const backup = await backupStep(t0, false);
    // Вечером копия обязана закончиться: незаконченная («partial») означает, что следующая попытка только завтра, поэтому 502.
    const backupBad = backup.state === 'error' || (backup.state === 'partial' && slot === 'evening');
    return res.status(st.failed || st.errors || left || backupBad ? 502 : 200).json({ date: now.date, slot, ...st, left, backup });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'failed', message: e.message });
  }
}
