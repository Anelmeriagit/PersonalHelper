export const TEST_USER = 'Test';
export const TEST_PASS = 'secret-pass';

export function setEnv() {
  delete process.env.AUTH_USER; // с этапа 3b бот читает документ привязанного аккаунта, переменная не нужна
  process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
  process.env.SESSION_VERSION = '1';
  process.env.DB_PREFIX = '';
  delete process.env.REG_OPEN;
  delete process.env.MAX_USERS;
}

export function mockReq({ method = 'GET', headers = {}, body } = {}) {
  return { method, headers, body };
}

export function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; this.ended = true; return this; },
    end(b) { if (b !== undefined) this.body = b; this.ended = true; return this; },
  };
}

// Один раз подменяет Date.now в тесте и даёт сдвигать время вперёд.
// Подмена снимается сама в конце теста (t.mock). Не вызывать дважды в одном тесте.
export function fakeClock(t) {
  const real = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => real() + offset);
  return { advance(ms) { offset += ms; } };
}

// Записывает документ кэшбэков поверх существующего: writeDoc принимает только текущую версию (CAS),
// поэтому повторная запись без etag даёт «Precondition failed». Для подготовки данных в тестах.
export async function seedDocForce(lib, user, doc) {
  const { etag } = await lib.readDoc(user);
  return lib.writeDoc(user, doc, etag);
}

// Создаёт аккаунт и привязывает к нему Telegram (как делает сайт + /start <токен>). from — объект Telegram from, chat по умолчанию from.id * 100 + 1.
// acc — модуль api/_acc.js (импортируют в тесте после setEnv). → id аккаунта.
export async function linkUser(acc, nick, from, chat = from.id * 100 + 1) {
  const { id } = await acc.createAccount(nick, 'pass-12345', 100);
  const { token } = await acc.createLinkToken(id);
  const r = await acc.bindTelegram(token, from, chat);
  if (r.error) throw new Error('linkUser: ' + r.error);
  return id;
}
