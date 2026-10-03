import { tg, webhookSecret, authed, BOT_COMMANDS } from './_bot.js';

// Однократная регистрация вебхука: curl -H "Authorization: Bearer <CRON_SECRET>" https://<домен>/api/tg-setup
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authed(req)) return res.status(401).json({ error: 'auth' });
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const url = `https://${host}/api/telegram`;
    await tg('setWebhook', { url, secret_token: webhookSecret(), allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
    await tg('setMyCommands', { commands: BOT_COMMANDS });
    await tg('setChatMenuButton', { menu_button: { type: 'commands' } });
    const info = await tg('getWebhookInfo');
    return res.status(200).json({ ok: true, url, info });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
