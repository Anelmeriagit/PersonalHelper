export const TEST_USER = 'Test';
export const TEST_PASS = 'secret-pass';

export function setEnv() {
  // AUTH_USER остаётся только для тестов бота (этап 3 уберёт): они используют его как id документа кэшбэков.
  process.env.AUTH_USER = TEST_USER;
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
