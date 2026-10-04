// Заглушки API для проверки интерфейса. Покрыты только чтения (GET) и «ничего не делающие» записи.
// Формы ответов взяты из PROJECT_NOTES.md; если клиент ждёт другое, поправить здесь.
// Незамоканные /api/* отвечают 404 {error:'mock'}, а smoke.mjs считает это ошибкой.

function mskMonth() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return p.find((x) => x.type === 'year').value + '-' + p.find((x) => x.type === 'month').value;
}

const qrRows = Array.from({ length: 21 }, (_, y) => Array.from({ length: 21 }, (_, x) => ((x * 7 + y * 3 + (x ^ y)) % 3 === 0 ? '1' : '0')).join(''));

export const qr = { size: 21, rows: qrRows };
export const routes = {
  'GET /api/data': () => ({
    user: 'test',
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
  'GET /api/reminders': () => ({ settings: {}, linked: { denis: true, zhanna: true }, custom: [], recurring: [] }),
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
  'POST /api/auth': () => ({ ok: true }), // вход, регистрация и выход (action в теле)
};
