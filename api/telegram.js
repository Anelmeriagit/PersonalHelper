import { loadDoc } from './_lib.js';
import { bindTelegram, accountOfTelegram, TOKEN_RE } from './_acc.js';
import { tg, readBot, mutateBot, webhookSecret, safeEq, cashbackTexts, chunkText, shopText, pendingGet, pendingPut, aliasSet, aliasDel, catChoices, shopKb, pickKb } from './_bot.js';
import { mskNow } from './_rem.js';
import { reindexAccount } from './_reindex.js';
import { resolveShop, disp } from './_shops.js';

const SHOP_CB = /^(sk|so|sp|sf|sr|sb)\|[0-9a-f]{8}(\|\d{1,3})?$/; // кнопки ответа по магазину (см. shopKb/pickKb в _bot.js)
const START_RE = /^\/start(?:@\w+)?(?=\s|$)\s*(\S*)/i; // группа 1: токен привязки (может быть пустым)
const NEW_LINK = ' Получите новую ссылку на сайте: Напоминания → «Привязать Telegram».';
const HINT = '\nИли выберите категорию кнопкой ниже: я запомню.';
const NO_DATA = 'Не удалось загрузить данные с сайта. Попробуйте чуть позже.';

// Текст и кнопки ответа по результату поиска. id — ожидающий запрос (есть, если удалось записать состояние).
function shopView(doc, mo, r, id, ch) {
  const text = shopText(doc, mo, r.res);
  if (id && r.key && r.res.kind === 'found') return { text, kb: shopKb(id, !!r.alias) };
  if (id && r.key && r.res.kind === 'unknown' && ch) return { text: text + HINT, kb: pickKb(id, ch.list, ch.f, false, false) };
  return { text, kb: [] };
}

// /start <токен>: привязка Telegram к аккаунту. Работает для любого человека в личном чате (токен выдаёт только сайт после входа).
async function onBind(m, token) {
  const say = (text) => tg('sendMessage', { chat_id: m.chat.id, text });
  if (!TOKEN_RE.test(token)) return say('Ссылка недействительна.' + NEW_LINK);
  let r;
  try { r = await bindTelegram(token, m.from, m.chat.id); }
  catch (e) { console.error(e); return say('Что-то пошло не так. Попробуйте ещё раз чуть позже.'); }
  if (r.error === 'busy') return say('Этот Telegram уже привязан к другому аккаунту. Отвяжите его там на сайте или откройте ссылку из другого Telegram.' + NEW_LINK);
  if (r.error) return say('Ссылка недействительна или устарела (она живёт 10 минут).' + NEW_LINK);
  try { await reindexAccount(r.id); } catch (e) { console.error('dueq reindex failed', e && e.message); } // напоминания, ждавшие привязки, попадают в индекс cron (сбой не отменяет привязку: суточная перестройка исправит)
  return say('Готово: Telegram привязан к вашему аккаунту.');
}

// uid — id аккаунта, к которому привязан этот Telegram (accountOfTelegram). Документ кэшбэков, псевдонимы и ожидающие запросы — этого аккаунта.
async function onMessage(m) {
  if (!m.chat || m.chat.type !== 'private') return; // группы: полная тишина
  const sm = START_RE.exec(String(m.text || ''));
  if (sm && sm[1]) return onBind(m, sm[1]);
  const uid = await accountOfTelegram(m.from && m.from.id);
  if (!uid) {
    // Не привязанный Telegram: только на /start подсказываем, как привязать; на всё остальное тишина.
    if (sm) await tg('sendMessage', { chat_id: m.chat.id, text: 'Привет! Чтобы привязать бота к аккаунту, откройте сайт: Напоминания → «Привязать Telegram».' });
    return;
  }
  if (sm) {
    await tg('sendMessage', { chat_id: m.chat.id, text: 'Привет! Telegram привязан к вашему аккаунту: напоминания будут приходить сюда. Список кэшбэков — в меню слева от поля ввода.' });
    return;
  }
  if (/^\/cashback(\s|@|$)/i.test(String(m.text || ''))) {
    let texts;
    try { texts = cashbackTexts((await loadDoc(uid)).doc, mskNow().month); }
    catch (e) {
      console.error(e);
      return tg('sendMessage', { chat_id: m.chat.id, text: NO_DATA });
    }
    for (const t of texts) for (const part of chunkText(t)) await tg('sendMessage', { chat_id: m.chat.id, text: part });
    return;
  }
  // Обычный текст = название магазина или категории. Команды и сообщения без текста молча игнорируем.
  const text = typeof m.text === 'string' ? m.text.trim() : '';
  if (!text || text[0] === '/') return;
  let doc;
  try { doc = (await loadDoc(uid)).doc; }
  catch (e) {
    console.error(e);
    return tg('sendMessage', { chat_id: m.chat.id, text: NO_DATA });
  }
  const mo = mskNow().month;
  let r, id = null, ch = null;
  try {
    r = resolveShop(text, doc.custom, (await readBot(uid)).state.alias);
    const known = r.key && (r.res.kind === 'found' || r.res.kind === 'unknown');
    // Запоминаем запрос ради кнопок. Если состояние не записалось, ответ всё равно уходит, просто без кнопок.
    if (known) {
      if (r.res.kind === 'unknown') ch = catChoices(doc, mo);
      id = await mutateBot(uid, (st) => pendingPut(st, text.slice(0, 100), Date.now(), ch ? { l: ch.list, f: ch.f, m: null } : { m: null }));
    }
  } catch (e) {
    console.error(e);
    id = null;
    if (!r) r = resolveShop(text, doc.custom, {});
  }
  const v = shopView(doc, mo, r, id, ch);
  const body = { chat_id: m.chat.id, text: v.text };
  if (v.kb.length) body.reply_markup = { inline_keyboard: v.kb };
  await tg('sendMessage', body);
}

// Кнопки ответа по магазину: «Не та категория», выбор категории, «Другая…», «Сбросить к словарю». Вызывается после accountOfTelegram; uid — аккаунт нажавшего.
async function onShopCb(cq, uid) {
  const ans = (extra) => tg('answerCallbackQuery', { callback_query_id: cq.id, ...extra }).catch(() => {});
  const msg = cq.message;
  if (!msg || !msg.chat) return ans();
  if (msg.chat.type !== 'private') return;
  const [act, id, ix] = String(cq.data).split('|');
  const chat = msg.chat.id, mid = msg.message_id;
  const swallow = (e) => { if (!/not modified/i.test(e.message)) throw e; };
  const edit = (text, kb) => tg('editMessageText', { chat_id: chat, message_id: mid, text, reply_markup: { inline_keyboard: kb || [] } }).catch(swallow);
  const editKb = (kb) => tg('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: kb } }).catch(swallow);
  const now = Date.now();
  const { state } = await readBot(uid);
  const pd = pendingGet(state, id, now);
  if (!pd) {
    await ans({ text: 'Запрос устарел. Напишите название магазина ещё раз.', show_alert: true });
    return editKb([]).catch(() => {});
  }
  // Показ списков работает по снимку из pd и сайт не читает.
  if (act === 'so' || act === 'sp') {
    if (!Array.isArray(pd.l) || typeof pd.f !== 'number') return ans();
    await ans();
    return editKb(pickKb(id, pd.l, pd.f, act === 'so', pd.m === 'fix'));
  }
  let doc;
  try { doc = (await loadDoc(uid)).doc; }
  catch (e) {
    console.error(e);
    return ans({ text: NO_DATA, show_alert: true });
  }
  const mo = mskNow().month;
  const r = resolveShop(pd.q, doc.custom, state.alias);
  if (!r.key || (r.res.kind !== 'found' && r.res.kind !== 'unknown')) {
    await ans({ text: 'Запрос устарел. Напишите название магазина ещё раз.', show_alert: true });
    return editKb([]).catch(() => {});
  }
  const title = r.res.kind === 'found' ? r.res.title : disp(pd.q);

  if (act === 'sb') { // отмена: вернуть ответ как был
    await ans();
    const v = shopView(doc, mo, r, id, null);
    return edit(v.text, v.kb);
  }
  if (act === 'sf') { // «Не та категория»: свежий список категорий
    const ch = catChoices(doc, mo);
    const nid = await mutateBot(uid, (st) => pendingPut(st, pd.q, now, { l: ch.list, f: ch.f, m: 'fix' }));
    await ans();
    return edit('Какая категория у «' + title + '»?', pickKb(nid, ch.list, ch.f, false, true));
  }
  if (act === 'sk') { // выбор категории: сохраняем личный псевдоним
    const c = Array.isArray(pd.l) && /^\d{1,3}$/.test(ix || '') ? pd.l[+ix] : null;
    if (typeof c !== 'string' || !catChoices(doc, mo).list.includes(c)) {
      return ans({ text: 'Такой категории уже нет. Начните заново: «Не та категория».', show_alert: true });
    }
    const alias = await mutateBot(uid, (st) => { aliasSet(st, r.key, c, title, now); pendingPut(st, pd.q, now, { m: null }); return st.alias; });
    const v = shopView(doc, mo, resolveShop(pd.q, doc.custom, alias), id, null);
    await ans({ text: 'Запомнил' });
    return edit(v.text, v.kb);
  }
  if (act === 'sr') { // сбросить к словарю: убрать псевдоним
    const out = await mutateBot(uid, (st) => {
      aliasDel(st, r.key);
      const r2 = resolveShop(pd.q, doc.custom, st.alias);
      const ch = r2.res.kind === 'unknown' ? catChoices(doc, mo) : null;
      return { r2, ch, id: pendingPut(st, pd.q, now, ch ? { l: ch.list, f: ch.f, m: null } : { m: null }) };
    });
    const v = shopView(doc, mo, out.r2, out.id, out.ch);
    await ans({ text: 'Сброшено к словарю' });
    return edit(v.text, v.kb);
  }
  return ans();
}

async function onCallback(cq) {
  const uid = await accountOfTelegram(cq.from && cq.from.id);
  if (!uid) return; // чужие нажатия: полная тишина
  if (SHOP_CB.test(String(cq.data || ''))) return onShopCb(cq, uid);
  // Прочие кнопки (например, от напоминаний прежней версии, которых больше нет): снимаем «часики» и сообщаем.
  await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Эта кнопка больше не работает.' }).catch(() => {});
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!safeEq(req.headers['x-telegram-bot-api-secret-token'] || '', webhookSecret())) return res.status(401).end();
  let u = null;
  try {
    u = req.body;
    if (typeof u === 'string') u = JSON.parse(u);
    if (u && u.callback_query) await onCallback(u.callback_query);
    else if (u && u.message) await onMessage(u.message);
  } catch (e) {
    console.error(e);
    // Пользователь не должен остаться без ответа: кнопка не «зависает», команда не молчит.
    try {
      const cq = u && u.callback_query, m = u && u.message;
      if (cq) await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Не получилось. Попробуйте ещё раз через минуту.', show_alert: true }, { retries: 0 });
      else if (m && m.chat && m.chat.type === 'private' && await accountOfTelegram(m.from && m.from.id)) await tg('sendMessage', { chat_id: m.chat.id, text: 'Что-то пошло не так. Попробуйте ещё раз чуть позже.' }, { retries: 0 });
    } catch (e2) { console.error('error reply failed', e2.message); }
  }
  // Всегда 200, иначе Telegram будет слать то же обновление повторно.
  return res.status(200).json({ ok: true });
}
