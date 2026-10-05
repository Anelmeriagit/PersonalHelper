// Рассылка личных напоминаний (этап 3b). Обход: множество tgs (аккаунты с привязанным Telegram, см. _acc.js) → rem:<id> → отправка в tg:<id>.chat.
// Hobby: cron раз в сутки, два слота (vercel.json: 11:00 UTC — «day», 15:00 UTC — «evening»). Точное время отправки сервер не гарантирует.
// Лимиты: общий поток Telegram около 30 сообщений в секунду (шлём не чаще 20), maxDuration функции 30 с (укладываемся в BUDGET_MS).
// Отметка «отправлено» ставится до отправки (planRem), поэтому повторный запуск не дублирует; не успевшие аккаунты (left) и сбои добираются повторным вызовом.
import { authed, sendCustom } from './_bot.js';
import { mskNow, readRem, mutateRem, planRem, unclaimRem } from './_rem.js';
import { linkedIds, getLink } from './_acc.js';

const BUDGET_MS = 24000; // из 30 с maxDuration: запас на последнюю отправку и ответ
const GAP_MS = 50; // между любыми двумя отправками
const WORKERS = 8; // аккаунтов читается параллельно (запросы к Redis), отправки идут общей очередью
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
  res.setHeader('Cache-Control', 'no-store');
  if (!authed(req)) return res.status(401).json({ error: 'auth' });
  const q = req.query || {};
  if (q.send) return res.status(400).json({ error: 'send removed' }); // тестовая отправка постоянных убрана вместе с ними; старый адрес не должен запускать рассылку
  try {
    // Сухой прогон: /api/cron?dry=1[&slot=evening][&date=2026-10-25] (заголовок Authorization: Bearer <CRON_SECRET>): ничего не отправляет и не пишет.
    // В ответе только числа: ни id аккаунтов, ни текстов.
    const dry = q.dry === '1';
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
    if (dry) return res.status(200).json({ dry: true, date: now.date, accounts: st.accounts, would_send: st.sent, nolink: st.nolink, errors: st.errors, left });
    return res.status(st.failed || st.errors || left ? 502 : 200).json({ date: now.date, slot, ...st, left });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'failed', message: e.message });
  }
}
