import { session } from './_lib.js';
import { readRem, pubRem } from './_rem.js';

// GET /api/reminders → { linked, custom, recurring } личных напоминаний аккаунта из сессии. Изменения идут через /api/custom и /api/recurring.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const id = session(req);
  if (!id) return res.status(401).json({ error: 'auth' });
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const { rem } = await readRem(id);
    return res.status(200).json(await pubRem(id, rem));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'storage' });
  }
}
