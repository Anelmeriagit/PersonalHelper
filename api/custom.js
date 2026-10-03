import crypto from 'node:crypto';
import { session } from './_lib.js';
import { PERSONS, CUSTOM_MAX, mskNow, mutate, pubState } from './_bot.js';

// Временные (разовые) напоминания.
//   POST   /api/custom           {date:'YYYY-MM-DD', slot:'day'|'evening', text, who:['denis','zhanna']}
//   PUT    /api/custom           {id, key:'on'|'denis'|'zhanna', value:boolean}   — переключатель / получатели
//   PUT    /api/custom           {id, text?, date?, slot?}                        — правка текста, даты, времени
//   DELETE /api/custom?id=<id>
// Каждый ответ — то же, что GET /api/reminders ({settings, linked, custom}).
// Отправку делает api/cron.js (слоты 14:00 и 18:00 по Москве).

const SLOT_HOUR = { day: 14, evening: 18 };
const MAX_DAYS = 370; // чуть больше года вперёд (на сайте — 365)
const MAX_TEXT = 300;

const hourMsk = () =>
  parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hourCycle: 'h23' }).format(new Date()), 10);

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function cleanText(v) {
  if (typeof v !== 'string') return '';
  return v
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const idOk = (s) => typeof s === 'string' && /^[0-9a-f]{12}$/.test(s);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!session(req)) return res.status(401).json({ error: 'auth' });
  try {
    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '');
      if (!idOk(id)) return res.status(400).json({ error: 'bad request' });
      const st = await mutate((s) => { s.custom = s.custom.filter((it) => !it || it.id !== id); return s; });
      return res.status(200).json(pubState(st));
    }

    if (req.method !== 'POST' && req.method !== 'PUT') return res.status(405).end();
    if (!String(req.headers['content-type'] || '').includes('application/json')) return res.status(415).end();
    let b = req.body;
    try { if (typeof b === 'string') b = JSON.parse(b); } catch { return res.status(400).json({ error: 'bad request' }); }
    b = b && typeof b === 'object' ? b : {};

    if (req.method === 'POST') {
      const { date, slot } = b;
      const text = cleanText(b.text);
      const who = Object.keys(PERSONS).filter((p) => Array.isArray(b.who) && b.who.includes(p)); // без дублей, только известные
      if (!validDate(date) || !own(SLOT_HOUR, slot) || !text || text.length > MAX_TEXT || !who.length) return res.status(400).json({ error: 'bad request' });
      const now = mskNow();
      const last = new Date(Date.parse(now.date + 'T00:00:00Z') + MAX_DAYS * 864e5).toISOString().slice(0, 10);
      if (date < now.date || date > last) return res.status(400).json({ error: 'bad date' });
      if (date === now.date && hourMsk() >= SLOT_HOUR[slot]) return res.status(400).json({ error: 'late' });
      const r = await mutate((s) => {
        if (s.custom.length >= CUSTOM_MAX) return { err: 'limit' };
        s.custom.push({ id: crypto.randomBytes(6).toString('hex'), date, slot, text, who, on: true, sent: {} });
        return s;
      });
      if (r.err) return res.status(409).json({ error: r.err });
      return res.status(200).json(pubState(r));
    }

    const { id } = b;
    if (!idOk(id)) return res.status(400).json({ error: 'bad request' });
    let r;

    if (!own(b, 'key')) {
      // PUT: правка текста, даты и/или времени (без пересоздания).
      // Полностью отправленное изменить нельзя; неотправленное просроченное можно перенести на новую дату.
      const hasText = own(b, 'text'), hasDate = own(b, 'date'), hasSlot = own(b, 'slot');
      if (!hasText && !hasDate && !hasSlot) return res.status(400).json({ error: 'bad request' });
      const text = hasText ? cleanText(b.text) : '';
      if (hasText && (!text || text.length > MAX_TEXT)) return res.status(400).json({ error: 'bad request' });
      if (hasDate && !validDate(b.date)) return res.status(400).json({ error: 'bad request' });
      if (hasSlot && !own(SLOT_HOUR, b.slot)) return res.status(400).json({ error: 'bad request' });
      const now = mskNow(), hour = hourMsk();
      const last = new Date(Date.parse(now.date + 'T00:00:00Z') + MAX_DAYS * 864e5).toISOString().slice(0, 10);
      r = await mutate((s) => {
        const it = s.custom.find((x) => x && x.id === id);
        if (!it) return { err: 'gone' };
        const who = Array.isArray(it.who) ? it.who : [];
        if (who.length && who.every((p) => it.sent && it.sent[p])) return { err: 'past' };
        const date = hasDate ? b.date : it.date, slot = hasSlot ? b.slot : it.slot;
        if (date !== it.date || slot !== it.slot) {
          // перенос: те же проверки, что при создании; отметки «отправлено» сбрасываются
          if (date < now.date || date > last) return { err: 'bad date' };
          if (date === now.date && hour >= SLOT_HOUR[slot]) return { err: 'late' };
          it.date = date; it.slot = slot; it.sent = {};
        }
        if (hasText) it.text = text;
        return s;
      });
    } else {
      // PUT: включить/выключить или изменить получателей
      const { key, value } = b;
      if (typeof value !== 'boolean' || !(key === 'on' || own(PERSONS, key))) return res.status(400).json({ error: 'bad request' });
      r = await mutate((s) => {
        const it = s.custom.find((x) => x && x.id === id);
        if (!it) return { err: 'gone' };
        if (key === 'on') { it.on = value; return s; }
        const w = new Set(Array.isArray(it.who) ? it.who : []);
        if (value) w.add(key); else w.delete(key);
        if (!w.size) return { err: 'empty' };
        it.who = Object.keys(PERSONS).filter((p) => w.has(p));
        return s;
      });
    }
    if (r.err === 'gone') return res.status(404).json({ error: 'gone' });
    if (r.err) return res.status(400).json({ error: r.err });
    return res.status(200).json(pubState(r));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'storage' });
  }
}
