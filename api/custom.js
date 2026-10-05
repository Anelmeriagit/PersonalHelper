import crypto from 'node:crypto';
import { session } from './_lib.js';
import { CUSTOM_MAX, SLOT_HOUR, MAX_TEXT, mskNow, hourMsk, validDate, cleanText, own, idOk, lastDay, mutateRem, pubRem } from './_rem.js';

// Временные (разовые) напоминания аккаунта из сессии. Данные: rem:<id> (см. _rem.js).
//   POST   /api/custom           {date:'YYYY-MM-DD', slot:'day'|'evening', text}
//   PUT    /api/custom           {id, key:'on', value:boolean}                  — включить / выключить
//   PUT    /api/custom           {id, text?, date?, slot?}                      — правка текста, даты, времени
//   DELETE /api/custom?id=<id>
// Каждый ответ — то же, что GET /api/reminders ({linked, custom, recurring}).
// Отправку делает api/cron.js (слоты 14:00 и 18:00 по Москве) в Telegram, привязанный к аккаунту.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const uid = session(req);
  if (!uid) return res.status(401).json({ error: 'auth' });
  try {
    const out = async (r) => res.status(200).json(await pubRem(uid, r.rem));

    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '');
      if (!idOk(id)) return res.status(400).json({ error: 'bad request' });
      return out(await mutateRem(uid, (s) => { s.custom = s.custom.filter((it) => it.id !== id); }));
    }

    if (req.method !== 'POST' && req.method !== 'PUT') return res.status(405).end();
    if (!String(req.headers['content-type'] || '').includes('application/json')) return res.status(415).end();
    let b = req.body;
    try { if (typeof b === 'string') b = JSON.parse(b); } catch { return res.status(400).json({ error: 'bad request' }); }
    b = b && typeof b === 'object' ? b : {};

    if (req.method === 'POST') {
      const { date, slot } = b;
      const text = cleanText(b.text);
      if (!validDate(date) || !own(SLOT_HOUR, slot) || !text || text.length > MAX_TEXT) return res.status(400).json({ error: 'bad request' });
      const now = mskNow();
      if (date < now.date || date > lastDay(now.date)) return res.status(400).json({ error: 'bad date' });
      if (date === now.date && hourMsk() >= SLOT_HOUR[slot]) return res.status(400).json({ error: 'late' });
      const r = await mutateRem(uid, (s) => {
        if (s.custom.length >= CUSTOM_MAX) return { err: 'limit' };
        s.custom.push({ id: crypto.randomBytes(6).toString('hex'), date, slot, text, on: true, sent: false });
      });
      if (r.err) return res.status(409).json({ error: r.err });
      return out(r);
    }

    const { id } = b;
    if (!idOk(id)) return res.status(400).json({ error: 'bad request' });
    let r;

    if (!own(b, 'key')) {
      // PUT: правка текста, даты и/или времени (без пересоздания: id остаётся).
      // Полностью отправленное изменить нельзя; неотправленное (в том числе просроченное) можно перенести на новую дату.
      const hasText = own(b, 'text'), hasDate = own(b, 'date'), hasSlot = own(b, 'slot');
      if (!hasText && !hasDate && !hasSlot) return res.status(400).json({ error: 'bad request' });
      const text = hasText ? cleanText(b.text) : '';
      if (hasText && (!text || text.length > MAX_TEXT)) return res.status(400).json({ error: 'bad request' });
      if (hasDate && !validDate(b.date)) return res.status(400).json({ error: 'bad request' });
      if (hasSlot && !own(SLOT_HOUR, b.slot)) return res.status(400).json({ error: 'bad request' });
      const now = mskNow(), hour = hourMsk(), last = lastDay(now.date);
      r = await mutateRem(uid, (s) => {
        const it = s.custom.find((x) => x.id === id);
        if (!it) return { err: 'gone' };
        if (it.sent) return { err: 'past' };
        const date = hasDate ? b.date : it.date, slot = hasSlot ? b.slot : it.slot;
        if (date !== it.date || slot !== it.slot) {
          // перенос: те же проверки, что при создании
          if (date < now.date || date > last) return { err: 'bad date' };
          if (date === now.date && hour >= SLOT_HOUR[slot]) return { err: 'late' };
          it.date = date; it.slot = slot;
        }
        if (hasText) it.text = text;
      });
    } else {
      // PUT: включить/выключить
      const { key, value } = b;
      if (key !== 'on' || typeof value !== 'boolean') return res.status(400).json({ error: 'bad request' });
      r = await mutateRem(uid, (s) => {
        const it = s.custom.find((x) => x.id === id);
        if (!it) return { err: 'gone' };
        it.on = value;
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
