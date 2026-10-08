import assert from 'node:assert/strict';
export function setEnv() {
  delete process.env.AUTH_USER; // с этапа 3b бот читает документ привязанного аккаунта, переменная не нужна
  process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
  process.env.SESSION_VERSION = '1';
  process.env.DB_PREFIX = '';
  delete process.env.MAX_USERS;
}

export function mockReq({ method = 'GET', headers = {}, body, query } = {}) {
  return query ? { method, headers, body, query } : { method, headers, body };
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

// Создаёт аккаунт Google (как делает вход через Google; sub = 'sub-' + имя) и возвращает его id.
// acc — модуль api/_acc.js (импортируют в тесте после setEnv).
export async function mkAccount(acc, name) {
  return (await acc.googleAccount('sub-' + name, '', 100)).id;
}

// Создаёт аккаунт и привязывает к нему Telegram (как делает сайт + /start <токен>). from — объект Telegram from, chat по умолчанию from.id * 100 + 1.
// acc — модуль api/_acc.js (импортируют в тесте после setEnv). → id аккаунта.
export async function linkUser(acc, name, from, chat = from.id * 100 + 1) {
  const id = await mkAccount(acc, name);
  const { token } = await acc.createLinkToken(id);
  const r = await acc.bindTelegram(token, from, chat);
  if (r.error) throw new Error('linkUser: ' + r.error);
  return id;
}

// Подменяет fetch для запросов к Telegram Bot API: любой другой запрос роняет тест. → массив вызовов { method, body }.
export function mockTg(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const m = String(url).match(/api\.telegram\.org\/bot[^/]+\/(\w+)/);
    assert.ok(m, 'неожиданный запрос: ' + url);
    calls.push({ method: m[1], body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }));
  });
  return calls;
}

// Создаёт аккаунт Google (sub = 'sub-' + имя) и возвращает куку сессии для запроса. acc — api/_acc.js, lib — api/_lib.js.
export async function sessionCookie(acc, lib, name) {
  const { id } = await acc.googleAccount('sub-' + name, '', 100);
  return lib.makeCookie(id).split(';')[0];
}
