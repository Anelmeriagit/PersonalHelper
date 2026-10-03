import { session } from './_lib.js';
import { REMINDERS, readState, mutate, pubState } from './_bot.js';

const pub = pubState;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!session(req)) return res.status(401).json({ error: 'auth' });
  try {
    if (req.method === 'GET') {
      const { state } = await readState();
      return res.status(200).json(pub(state));
    }
    if (req.method === 'PUT') {
      if (!String(req.headers['content-type'] || '').includes('application/json')) return res.status(415).end();
      let b = req.body;
      if (typeof b === 'string') b = JSON.parse(b);
      const { id, key, value } = b || {};
      const R = REMINDERS[id];
      if (!R || typeof value !== 'boolean' || !(key === 'on' || R.who.includes(key))) return res.status(400).json({ error: 'bad request' });
      const state = await mutate((st) => {
        st.settings[id] = { ...(st.settings[id] || {}), [key]: value };
        return st;
      });
      return res.status(200).json(pub(state));
    }
    return res.status(405).end();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'storage' });
  }
}
