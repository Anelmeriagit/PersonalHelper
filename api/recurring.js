import crypto from 'node:crypto';
import { session } from './_lib.js';
import { EVERY, RECURRING_MAX, SLOT_MIN, MAX_TEXT, mskNow, minOf, validDate, cleanText, own, idOk, lastDay, target, newShrRec } from './_rem.js';

// Повторяющиеся напоминания аккаунта из сессии. Данные: rem:<id> (см. _rem.js).
//   POST   /api/recurring   {date:'YYYY-MM-DD', every:'week'|'2weeks'|'month', slot:'h07'|'h07m30' … 'h23'|'h23m30' (или 'day'|'evening'), text, shared?:true}
//   PUT    /api/recurring   {id, key:'on', value:boolean, shared?:true, who?:'me'|'partner'}   — включить / выключить
//   PUT    /api/recurring   {id, text?, date?, slot?, every?, shared?:true}                    — правка (date — новая дата отсчёта)
//   DELETE /api/recurring?id=<id>[&shared=1]
// shared, who и 409 {error:'nopair'}: как у /api/custom (общее напоминание соединённой пары, у каждого аккаунта своя галочка).
// Каждый ответ — то же, что GET /api/reminders ({linked, custom, recurring, shared?}).
// Отправку делает api/cron.js (слоты с шагом 30 минут по Москве), расписание считает recDue() в _rem.js.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const uid = session(req);
  if (!uid) return res.status(401).json({ error: 'auth' });
  try {
    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '');
      if (!idOk(id)) return res.status(400).json({ error: 'bad request' });
      const T = await target(uid, !!req.query && req.query.shared === '1');
      if (!T) return res.status(409).json({ error: 'nopair' });
      const r = await T.mut((s) => { s.recurring = s.recurring.filter((it) => it.id !== id); });
      return res.status(200).json(await T.out(r));
    }

    if (req.method !== 'POST' && req.method !== 'PUT') return res.status(405).end();
    if (!String(req.headers['content-type'] || '').includes('application/json')) return res.status(415).end();
    let b = req.body;
    try { if (typeof b === 'string') b = JSON.parse(b); } catch { return res.status(400).json({ error: 'bad request' }); }
    b = b && typeof b === 'object' ? b : {};
    const T = await target(uid, b.shared === true);
    if (!T) return res.status(409).json({ error: 'nopair' });
    const out = async (r) => res.status(200).json(await T.out(r));

    if (req.method === 'POST') {
      const { date, slot, every } = b;
      const text = cleanText(b.text);
      if (!validDate(date) || !own(SLOT_MIN, slot) || !EVERY.includes(every) || !text || text.length > MAX_TEXT) return res.status(400).json({ error: 'bad request' });
      const now = mskNow();
      if (date < now.date || date > lastDay(now.date)) return res.status(400).json({ error: 'bad date' });
      if (date === now.date && minOf(now) >= SLOT_MIN[slot]) return res.status(400).json({ error: 'late' });
      const r = await T.mut((s) => {
        if (s.recurring.length >= RECURRING_MAX) return { err: 'limit' };
        const it = { id: crypto.randomBytes(6).toString('hex'), date, every, slot, text, on: true, sent: {} };
        s.recurring.push(T.sh ? newShrRec(it) : it);
      });
      if (r.err) return res.status(409).json({ error: r.err });
      return out(r);
    }

    const { id } = b;
    if (!idOk(id)) return res.status(400).json({ error: 'bad request' });
    let r;

    if (!own(b, 'key')) {
      // PUT: правка текста, времени, частоты и/или даты отсчёта. Отметки «отправлено» хранятся по датам, поэтому
      // сегодняшнюю отправку после правки повторно не пришлют.
      const hasText = own(b, 'text'), hasDate = own(b, 'date'), hasSlot = own(b, 'slot'), hasEvery = own(b, 'every');
      if (!hasText && !hasDate && !hasSlot && !hasEvery) return res.status(400).json({ error: 'bad request' });
      const text = hasText ? cleanText(b.text) : '';
      if (hasText && (!text || text.length > MAX_TEXT)) return res.status(400).json({ error: 'bad request' });
      if (hasDate && !validDate(b.date)) return res.status(400).json({ error: 'bad request' });
      if (hasSlot && !own(SLOT_MIN, b.slot)) return res.status(400).json({ error: 'bad request' });
      if (hasEvery && !EVERY.includes(b.every)) return res.status(400).json({ error: 'bad request' });
      const now = mskNow();
      if (hasDate && (b.date < now.date || b.date > lastDay(now.date))) return res.status(400).json({ error: 'bad date' });
      r = await T.mut((s) => {
        const it = s.recurring.find((x) => x.id === id);
        if (!it) return { err: 'gone' };
        if (hasDate) it.date = b.date;
        if (hasSlot) it.slot = b.slot;
        if (hasEvery) it.every = b.every;
        if (hasText) it.text = text;
      });
    } else {
      // PUT: включить/выключить
      const { key, value } = b;
      if (key !== 'on' || typeof value !== 'boolean') return res.status(400).json({ error: 'bad request' });
      if (own(b, 'who') && b.who !== 'me' && b.who !== 'partner') return res.status(400).json({ error: 'bad request' });
      r = await T.mut((s, me, they) => {
        const it = s.recurring.find((x) => x.id === id);
        if (!it) return { err: 'gone' };
        if (T.sh) it.on[b.who === 'partner' ? they : me] = value; else it.on = value;
      });
    }
    if (r.err === 'gone') return res.status(404).json({ error: 'gone' });
    if (r.err) return res.status(400).json({ error: r.err });
    return out(r);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'storage' });
  }
}
