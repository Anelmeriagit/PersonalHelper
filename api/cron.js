import { REMINDERS, PERSONS, TEST_CYCLE, mskNow, mutate, readState, planDue, linkedOf, sendReminder, sendCustom, authed, notifyAdmin, unclaim } from './_bot.js';

function failText(failed, now, slot) {
  const lines = failed.map((f) => '• ' + (f.rec ? 'Повторяющееся напоминание' : f.custom ? 'Своё напоминание' : REMINDERS[f.id].title) + ' — ' + (PERSONS[f.p] ? PERSONS[f.p].name : f.p) + ': ' + f.error);
  return '⚠️ Не удалось отправить напоминания (' + now.date + ', ' + (slot === 'evening' ? 'вечер' : 'день') + '):\n' + lines.join('\n') +
    '\n\nПовторить: curl -H "Authorization: Bearer <CRON_SECRET>" https://<домен>/api/cron' + (slot === 'evening' ? '?slot=evening' : '') + ' — уже доставленным дубль не уйдёт.';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authed(req)) return res.status(401).json({ error: 'auth' });
  const q = req.query || {};
  try {
    // Ручной тест внешнего вида и кнопок: /api/cron?send=halva (ключ в заголовке Authorization: Bearer <CRON_SECRET>)
    // Расписание и отметки реальных циклов не затрагивает (отдельный тестовый цикл).
    if (q.send) {
      const R = REMINDERS[q.send];
      if (!R) return res.status(400).json({ error: 'unknown reminder', ids: Object.keys(REMINDERS) });
      await mutate((st) => { delete st.cycles[q.send + ':' + TEST_CYCLE]; });
      const { state } = await readState();
      const sent = await Promise.all(R.who.map(async (p) => {
        const chat = state.users[p] && state.users[p].chat;
        if (!chat) return { p, ok: false, error: 'нет /start' };
        try { await sendReminder(chat, q.send, TEST_CYCLE); return { p, ok: true }; }
        catch (e) { return { p, ok: false, error: e.message }; }
      }));
      return res.status(200).json({ test: true, sent });
    }

    // Сухой прогон: /api/cron?dry=1[&date=2026-10-25] (тот же заголовок) — ничего не отправляет и не записывает.
    if (q.dry === '1') {
      let now = mskNow();
      if (q.date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date)) return res.status(400).json({ error: 'date: YYYY-MM-DD' });
        now = { month: q.date.slice(0, 7), date: q.date };
      }
      const { state } = await readState();
      const plan = planDue(JSON.parse(JSON.stringify(state)), now, q.slot);
      return res.status(200).json({ dry: true, date: now.date, linked: linkedOf(state), would_send: plan.map(({ id, p, cycle, cid }) => ({ id, p, cycle, cid })) });
    }
    if (q.date) return res.status(400).json({ error: 'date работает только с dry=1' });

    const now = mskNow();
    // Два запуска в сутки: «day» (14:00–15:00 МСК) и «evening» (18:00–19:00 МСК, /api/cron?slot=evening)
    const slot = q.slot === 'evening' ? 'evening' : 'day';
    const claims = await mutate((st) => planDue(st, now, slot));
    const sent = await Promise.all(claims.map(async (c) => {
      try { await (c.custom ? sendCustom(c.chat, c.text) : sendReminder(c.chat, c.id, c.cycle)); return { id: c.id, p: c.p, ok: true }; }
      catch (e) { console.error('send failed', c.id, c.p, e.message); return { id: c.id, cid: c.cid, custom: c.custom, rec: c.rec, p: c.p, cycle: c.cycle, date: c.date, ok: false, error: e.message }; }
    }));
    const failed = sent.filter((s) => !s.ok);
    let notified = null;
    if (failed.length) {
      try { await unclaim(failed); } catch (e) { console.error('unclaim failed', e.message); }
      notified = await notifyAdmin(failText(failed, now, slot));
    }
    return res.status(failed.length ? 502 : 200).json({ date: now.date, slot, sent: sent.map(({ id, p, ok, error }) => ({ id, p, ok, error })), notified });
  } catch (e) {
    console.error(e);
    if (!q.send && q.dry !== '1') await notifyAdmin('⚠️ Cron завершился с ошибкой: ' + e.message);
    return res.status(500).json({ error: 'failed', message: e.message });
  }
}
