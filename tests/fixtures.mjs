// Заглушки API для проверки интерфейса. Покрыты только чтения (GET) и «ничего не делающие» записи.
// Формы ответов взяты из PROJECT_NOTES.md; если клиент ждёт другое, поправить здесь.
// Незамоканные /api/* отвечают 404 {error:'mock'}, а smoke.mjs считает это ошибкой.

function mskMonth() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return p.find((x) => x.type === 'year').value + '-' + p.find((x) => x.type === 'month').value;
}

// Дата по Москве со сдвигом в днях (YYYY-MM-DD)
export function mskDay(offset = 0) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 864e5));
  return p;
}

const qrRows = Array.from({ length: 21 }, (_, y) => Array.from({ length: 21 }, (_, x) => ((x * 7 + y * 3 + (x ^ y)) % 3 === 0 ? '1' : '0')).join(''));

export const qr = { size: 21, rows: qrRows };
export const routes = {
  'GET /api/data': () => ({
    user: 'test',
    name: '', // отображаемое имя; пусто: в шапке «Helper User»
    data: {
      months: {
        [mskMonth()]: [
          { bank: 'otp', items: [{ cat: 'Маркетплейсы', pct: '12' }, { cat: 'АЗС', pct: '5' }] },
          { bank: 'alfa', items: [{ cat: 'Маркетплейсы', pct: '5' }] },
          { bank: 'sber', items: [{ cat: 'Супермаркеты', pct: '10' }] },
        ],
      },
      custom: [],
    },
    rev: {},
  }),
  'PUT /api/data': () => ({ ok: true }),
  // Форма ответа этапа 3b: { linked: bool, custom, recurring }; PUT /api/reminders больше нет
  'GET /api/reminders': () => ({
    linked: true,
    custom: [{ id: 'aaaaaaaaaaaa', date: mskDay(3), slot: 'day', text: 'Позвонить <b>маме</b>', on: true, sent: false }],
    recurring: [{ id: 'bbbbbbbbbbbb', date: mskDay(2), every: 'week', slot: 'evening', text: 'Полить цветы', on: true, next: mskDay(2) }],
  }),
  'GET /api/agent': () => ({
    rows: [
      { id: 'a1', app: 'app', h: null, m: null },
      { id: 'a2', app: 'opera', h: null, m: null },
      { id: 'a3', app: 'mozilla', h: null, m: null },
      { id: 'a4', app: 'edge', h: null, m: null },
    ],
  }),
  'PUT /api/agent': (body) => ({ rows: (body && body.rows) || [] }),
  'GET /api/wifi': () => ({ configured: true, ssid: 'TestNet', password: 'test-password', security: 'WPA', hidden: false, qr: { size: 21, rows: qrRows } }),
  'PUT /api/wifi': (body) => ({ configured: true, ssid: body && body.ssid, password: (body && body.password) || '', security: (body && body.security) || 'WPA', hidden: !!(body && body.hidden), qr: { size: 21, rows: qrRows } }),
  'DELETE /api/wifi': () => ({ configured: false }),
  // вход, регистрация, выход; me / rename / delete — меню и окно «Настройки аккаунта» (форма ответов в notes/account.md)
  'POST /api/auth': (body) => {
    const a = body && body.action;
    if (a === 'me') return { id: '0123456789abcdef0123456789abcdef', name: '', email: '', tg: { linked: false } };
    if (a === 'rename') return { name: String(body.name || '') };
    return { ok: true };
  },
  'GET /api/tglink': () => ({ linked: false }),
  'POST /api/tglink': () => ({ url: 'https://t.me/TestBot?start=AAAAAAAAAAAAAAAAAAAAAA', ttl: 600 }),
  'DELETE /api/tglink': () => ({ linked: false }),
};
