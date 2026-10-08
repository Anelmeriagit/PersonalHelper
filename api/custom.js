import crypto from 'node:crypto';
import { session } from './_lib.js';
import { CUSTOM_MAX, SLOT_HOUR, MAX_TEXT, mskNow, hourMsk, validDate, cleanText, own, idOk, lastDay, target, newShrCustom, anySent } from './_rem.js';

// Временные (разовые) напоминания аккаунта из сессии. Данные: rem:<id> (см. _rem.js).
//   POST   /api/custom           {date:'YYYY-MM-DD', slot:'day'|'evening', text, shared?:true}
//   PUT    /api/custom           {id, key:'on', value:boolean, shared?:true, who?:'me'|'partner'}   — включить / выключить
//   PUT    /api/custom           {id, text?, date?, slot?, shared?:true}                            — правка текста, даты, времени
//   DELETE /api/custom?id=<id>[&shared=1]
// shared — общее напоминание соединённой пары (запись shr:…, _rem.js); без связи 409 {error:'nopair'}. У общего две галочки (у каждого аккаунта своя):
// who выбирает, чью менять (по умолчанию свою; менять может любой из двоих). Общее считается отправленным, если ушло хоть кому-то (правка → 400 past).
// Каждый ответ — то же, что GET /api/reminders ({linked, custom, recurring, shared?}).
// Отправку делает api/cron.js (слоты 14:00 и 18:00 по Москве) в Telegram, привязанный к аккаунту.

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
      const r = await T.mut((s) => { s.custom = s.custom.filter((it) => it.id !== id); });
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
      const { date, slot } = b;
      const text = cleanText(b.text);
      if (!validDate(date) || !own(SLOT_HOUR, slot) || !text || text.length > MAX_TEXT) return res.status(400).json({ error: 'bad request' });
      const now = mskNow();
      if (date < now.date || date > lastDay(now.date)) return res.status(400).json({ error: 'bad date' });
      if (date === now.date && hourMsk() >= SLOT_HOUR[slot]) return res.status(400).json({ error: 'late' });
      const r = await T.mut((s) => {
        if (s.custom.length >= CUSTOM_MAX) return { err: 'limit' };
        const it = { id: crypto.randomBytes(6).toString('hex'), date, slot, text, on: true, sent: false };
        s.custom.push(T.sh ? newShrCustom(it) : it);
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
      r = await T.mut((s) => {
        const it = s.custom.find((x) => x.id === id);
        if (!it) return { err: 'gone' };
        if (T.sh ? anySent(it) : it.sent) return { err: 'past' };
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
      if (own(b, 'who') && b.who !== 'me' && b.who !== 'partner') return res.status(400).json({ error: 'bad request' });
      r = await T.mut((s, me, they) => {
        const it = s.custom.find((x) => x.id === id);
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
