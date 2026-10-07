// Вход через Google, этап 5, часть 3: GET /api/auth?action=google и google-cb (api/auth.js), googleAccount и удаление gid (api/_acc.js).
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
// Google в тестах — мок fetch на https://oauth2.googleapis.com/token; запросы к Redis идут в заглушку как обычно.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { __reset, __keys, __raw, __cmdLog } from './redis.mjs';
import { mockReq, mockRes, setEnv, fakeClock } from './helpers.mjs';

setEnv();
const auth = (await import('../api/auth.js')).default;
const acc = await import('../api/_acc.js');
const lib = await import('../api/_lib.js');
const B = await import('../api/_backup.js');

const CID = 'client-id-for-tests';
const HOST = 'app.example.test';
let realFetch, tokenCalls;
// reply(body) → объект ответа токен-эндпоинта; по умолчанию успешный вход (sub s1)
let reply;
beforeEach(() => {
  __reset(); setEnv();
  process.env.GOOGLE_CLIENT_ID = CID; process.env.GOOGLE_CLIENT_SECRET = 'secret-for-tests';
  realFetch = globalThis.fetch; tokenCalls = [];
  reply = null;
  globalThis.fetch = async (url, opts) => {
    if (String(url) !== 'https://oauth2.googleapis.com/token') return realFetch(url, opts);
    const body = Object.fromEntries(new URLSearchParams(String(opts.body)));
    tokenCalls.push(body);
    const r = reply ? await reply(body) : { status: 200, json: { id_token: idToken({ nonce: body.__nonce }) } };
    return new Response(typeof r.json === 'string' ? r.json : JSON.stringify(r.json), { status: r.status });
  };
});
afterEach(() => { globalThis.fetch = realFetch; delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; delete process.env.MAX_USERS; });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
// id_token без настоящей подписи: сервер проверяет содержимое (токен пришёл напрямую от Google по TLS)
function idToken(over) {
  const c = { iss: 'https://accounts.google.com', aud: CID, sub: 's1', exp: Math.floor(Date.now() / 1000) + 3600, email: 'Anna@Example.com', email_verified: true, ...over };
  return b64({ alg: 'RS256' }) + '.' + b64(c) + '.sig';
}
const hdr = (cookie, ip = '10.0.0.7') => ({ host: HOST, 'x-real-ip': ip, ...(cookie ? { cookie } : {}) });
async function get(action, { query = {}, cookie, ip, host } = {}) {
  const res = mockRes();
  await auth(mockReq({ method: 'GET', headers: { ...hdr(cookie, ip), ...(host ? { host } : {}) }, query: { action, ...query } }), res);
  return res;
}
const cookies = (res) => [].concat(res.headers['set-cookie'] || []);
const oauthCookie = (res) => cookies(res).find((c) => c.startsWith('cb_oauth=') && !/Max-Age=0/.test(c));
const pairOf = (c) => String(c).split(';')[0];
const stateOf = (res) => new URL(res.headers.location).searchParams.get('state');
const loc = (res) => res.headers.location;

// start → (ответ Google подставляется тестом через reply) → cb. Возвращает ответ cb.
async function flow({ idOver, query, tamper, ip } = {}) {
  const s = await get('google', { ip });
  const ck = oauthCookie(s);
  const st = JSON.parse(Buffer.from(ck.slice('cb_oauth='.length).split('.')[0], 'base64url').toString());
  if (!reply) reply = async () => ({ status: 200, json: { id_token: idToken({ nonce: st.n, ...idOver }) } });
  const cookie = tamper ? tamper(pairOf(ck)) : pairOf(ck);
  return get('google-cb', { query: { code: 'code-1', state: stateOf(s), ...query }, cookie, ip });
}

/* ---------- старт ---------- */
test('старт без ключей Google: на главную с кодом off, cookie не ставится', async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  const r = await get('google');
  assert.equal(r.statusCode, 302); assert.equal(loc(r), '/?gerr=off'); assert.equal(cookies(r).length, 0);
  process.env.GOOGLE_CLIENT_ID = CID; process.env.GOOGLE_CLIENT_SECRET = '';
  assert.equal(loc(await get('google')), '/?gerr=off');
});

test('старт: адрес Google с PKCE S256, state, nonce, обратным адресом хоста и короткой подписанной cookie; в Redis ничего не пишется', async () => {
  const r = await get('google');
  assert.equal(r.statusCode, 302);
  const u = new URL(loc(r));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const q = u.searchParams;
  assert.equal(q.get('client_id'), CID);
  assert.equal(q.get('redirect_uri'), `https://${HOST}/api/auth?action=google-cb`);
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), 'openid email');
  assert.equal(q.get('code_challenge_method'), 'S256');
  const ck = oauthCookie(r);
  assert.match(ck, /; HttpOnly/); assert.match(ck, /; Secure/); assert.match(ck, /; SameSite=Lax/); assert.match(ck, /; Path=\/api\/auth/); assert.match(ck, /Max-Age=600/);
  const st = JSON.parse(Buffer.from(ck.slice('cb_oauth='.length).split('.')[0], 'base64url').toString());
  assert.equal(q.get('state'), st.s); assert.equal(q.get('nonce'), st.n);
  assert.equal(q.get('code_challenge'), crypto.createHash('sha256').update(st.v).digest('base64url'));
  assert.equal(__cmdLog().length, 0); assert.equal(__keys().length, 0);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('старт: странный Host не годится для обратного адреса; localhost идёт по http; Google-секрет не уходит в адрес', async () => {
  assert.equal(loc(await get('google', { host: 'evil.test/x?y' })), '/?gerr=off');
  const l = await get('google', { host: 'localhost:3000' });
  assert.equal(new URL(loc(l)).searchParams.get('redirect_uri'), 'http://localhost:3000/api/auth?action=google-cb');
  assert.ok(!loc(l).includes('secret-for-tests'));
});

test('другой метод и неизвестное действие: 405; POST с action google: 400', async () => {
  assert.equal((await get('nope')).statusCode, 405);
  const res = mockRes();
  await auth(mockReq({ method: 'POST', headers: hdr(), body: { action: 'google' } }), res);
  assert.equal(res.statusCode, 400);
});

/* ---------- возврат ---------- */
test('новый вход: аккаунт без nick и pw, id_token проверен, сессия и сброс cookie входа, переход на /', async () => {
  const r = await flow();
  assert.equal(r.statusCode, 302); assert.equal(loc(r), '/');
  const cs = cookies(r);
  assert.equal(cs.length, 2);
  const sess = cs.find((c) => c.startsWith('cb_session='));
  assert.ok(sess && /SameSite=Strict/.test(sess));
  assert.match(cs.find((c) => c.startsWith('cb_oauth=')), /Max-Age=0/);
  const id = lib.session({ headers: { cookie: pairOf(sess) } });
  assert.match(id, /^[0-9a-f]{32}$/);
  const rec = JSON.parse(__raw('acc:' + id));
  assert.deepEqual(Object.keys(rec).sort(), ['at', 'email', 'gsub']);
  assert.equal(rec.gsub, 's1'); assert.equal(rec.email, 'Anna@Example.com');
  assert.equal(__raw('gid:s1'), id); assert.equal(__raw('users'), '1');
  // запрос к токен-эндпоинту: код, PKCE-проверка, обратный адрес
  assert.equal(tokenCalls.length, 1);
  const t = tokenCalls[0];
  assert.equal(t.grant_type, 'authorization_code'); assert.equal(t.code, 'code-1'); assert.equal(t.client_id, CID);
  assert.equal(t.redirect_uri, `https://${HOST}/api/auth?action=google-cb`); assert.ok(t.code_verifier.length >= 43); assert.ok(t.client_secret);
  // me: почта есть, имя пустое
  const me = mockRes();
  await auth(mockReq({ method: 'POST', headers: { cookie: pairOf(sess) }, body: { action: 'me' } }), me);
  assert.deepEqual(me.body, { id, name: '', email: 'Anna@Example.com', tg: { linked: false } });
});

test('повторный вход с тем же sub: тот же аккаунт, счётчик не растёт, запись acc не переписывается', async () => {
  const a = await flow();
  const id = lib.session({ headers: { cookie: pairOf(cookies(a).find((c) => c.startsWith('cb_session='))) } });
  const before = __raw('acc:' + id);
  reply = null;
  const b = await flow({ idOver: { email: 'other@example.com' } });
  const id2 = lib.session({ headers: { cookie: pairOf(cookies(b).find((c) => c.startsWith('cb_session='))) } });
  assert.equal(id2, id); assert.equal(__raw('users'), '1'); assert.equal(__raw('acc:' + id), before);
});

test('расход команд Redis: старт 0, новый аккаунт 5 (лимит, GET gid, INCR users, SET acc, SET gid), повторный вход 3 (лимит, GET gid, GET acc)', async () => {
  __cmdLog(true);
  const s = await get('google');
  assert.equal(__cmdLog(true).length, 0);
  const st = JSON.parse(Buffer.from(oauthCookie(s).slice('cb_oauth='.length).split('.')[0], 'base64url').toString());
  reply = async () => ({ status: 200, json: { id_token: idToken({ nonce: st.n }) } });
  await get('google-cb', { query: { code: 'c', state: stateOf(s) }, cookie: pairOf(oauthCookie(s)) });
  assert.deepEqual(__cmdLog(true).map((c) => c.split(' ')[0]), ['EVAL', 'GET', 'INCR', 'SET', 'SET']);
  const s2 = await get('google');
  const st2 = JSON.parse(Buffer.from(oauthCookie(s2).slice('cb_oauth='.length).split('.')[0], 'base64url').toString());
  reply = async () => ({ status: 200, json: { id_token: idToken({ nonce: st2.n }) } });
  __cmdLog(true);
  await get('google-cb', { query: { code: 'c', state: stateOf(s2) }, cookie: pairOf(oauthCookie(s2)) });
  assert.equal(__cmdLog(true).length, 3);
});

test('почта не подтверждена Google: аккаунт создаётся без почты', async () => {
  const r = await flow({ idOver: { email_verified: false } });
  const id = lib.session({ headers: { cookie: pairOf(cookies(r).find((c) => c.startsWith('cb_session='))) } });
  assert.equal(JSON.parse(__raw('acc:' + id)).email, undefined);
});

test('почта с угловыми скобками или кавычками отбрасывается, длинная тоже', () => {
  assert.equal(acc.cleanEmail('a@b.co'), 'a@b.co');
  assert.equal(acc.cleanEmail('<script>@b.co'), ''); assert.equal(acc.cleanEmail('a"b@c.co'), '');
  assert.equal(acc.cleanEmail('a'.repeat(250) + '@b.co'), ''); assert.equal(acc.cleanEmail(null), '');
});

test('state: нет cookie, чужая подпись, другой state, просроченная cookie — код state, на Google не ходим, аккаунта нет', async (t) => {
  const s = await get('google');
  const ck = pairOf(oauthCookie(s)), good = stateOf(s);
  const cases = [
    get('google-cb', { query: { code: 'c', state: good } }),
    get('google-cb', { query: { code: 'c', state: good }, cookie: ck.slice(0, -2) + 'xx' }),
    get('google-cb', { query: { code: 'c', state: 'other' }, cookie: ck }),
    get('google-cb', { query: { code: 'c' }, cookie: ck }),
  ];
  for (const r of await Promise.all(cases)) { assert.equal(loc(r), '/?gerr=state'); assert.match(cookies(r)[0], /^cb_oauth=.*Max-Age=0/); }
  const clock = fakeClock(t); clock.advance(11 * 60 * 1000);
  assert.equal(loc(await get('google-cb', { query: { code: 'c', state: good }, cookie: ck })), '/?gerr=state');
  assert.equal(tokenCalls.length, 0); assert.equal(__keys().length, 0);
});

test('cookie входа нельзя собрать из cookie сессии: другая подпись', async () => {
  const s = await get('google');
  const forged = 'cb_oauth=' + lib.makeCookie('a'.repeat(32)).split(';')[0].slice('cb_session='.length);
  assert.equal(loc(await get('google-cb', { query: { code: 'c', state: stateOf(s) }, cookie: forged })), '/?gerr=state');
});

test('отказ пользователя: denied; другая ошибка Google: fail; cookie входа сбрасывается', async () => {
  const f = async (error) => { const s = await get('google'); return get('google-cb', { query: { state: stateOf(s), error }, cookie: pairOf(oauthCookie(s)) }); };
  const d = await f('access_denied'); assert.equal(loc(d), '/?gerr=denied'); assert.match(cookies(d)[0], /Max-Age=0/);
  assert.equal(loc(await f('server_error')), '/?gerr=fail');
  assert.equal(tokenCalls.length, 0);
});

test('id_token не прошёл проверку: чужой nonce, aud, iss, истёк, нет sub — fail и аккаунт не создаётся', async () => {
  const bad = [{ nonce: 'x' }, { aud: 'other' }, { iss: 'https://evil.test' }, { exp: Math.floor(Date.now() / 1000) - 10 }, { sub: '' }, { sub: undefined }, { exp: 'abc' }];
  for (const over of bad) {
    const r = await flow({ idOver: over });
    assert.equal(loc(r), '/?gerr=fail', JSON.stringify(over)); assert.ok(!cookies(r).some((c) => c.startsWith('cb_session=')));
    reply = null;
  }
  assert.equal(__keys().filter((k) => /^(acc|gid|users)/.test(k)).length, 0);
});

test('sub с недопустимыми символами отвергается', async () => {
  const r = await flow({ idOver: { sub: 'a b/c' } });
  assert.equal(loc(r), '/?gerr=fail'); assert.equal(__keys().filter((k) => /^(acc|gid|users)/.test(k)).length, 0);
});

test('сбои Google: HTTP 400, не JSON, нет id_token, исключение сети — fail, секрет и код не попадают в журнал', async (t) => {
  const logs = []; t.mock.method(console, 'error', (...a) => logs.push(a.join(' ')));
  for (const r of [async () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Bad code-1' } }), async () => ({ status: 200, json: 'не json' }), async () => ({ status: 200, json: {} }), async () => { throw new Error('boom'); }]) {
    reply = r; const x = await flow(); assert.equal(loc(x), '/?gerr=fail');
  }
  const all = logs.join('\n');
  assert.ok(!all.includes('secret-for-tests') && !all.includes('code-1') && !all.includes('Bad code'));
  assert.equal(__keys().filter((k) => /^(acc|gid)/.test(k)).length, 0);
});

test('MAX_USERS: новый аккаунт сверх предела — full, счётчик откатывается; существующий входит', async () => {
  process.env.MAX_USERS = '1';
  assert.equal(loc(await flow({ idOver: { sub: 's1' } })), '/');
  reply = null;
  const f = await flow({ idOver: { sub: 's2' } });
  assert.equal(loc(f), '/?gerr=full'); assert.equal(__raw('users'), '1'); assert.equal(__raw('gid:s2'), undefined);
  reply = null;
  assert.equal(loc(await flow({ idOver: { sub: 's1' } })), '/');
});

test('вход через Google не зависит от REG_OPEN', async () => {
  delete process.env.REG_OPEN;
  assert.equal(loc(await flow()), '/');
});

test('лимит с одного адреса: 20 возвратов в час, 21-й — rate; другой адрес не задет', async () => {
  for (let i = 0; i < 20; i++) { reply = null; assert.equal(loc(await flow({ ip: '10.9.9.9' })), '/'); }
  reply = null; assert.equal(loc(await flow({ ip: '10.9.9.9' })), '/?gerr=rate');
  reply = null; assert.equal(loc(await flow({ ip: '10.9.9.8' })), '/');
});

test('два первых входа с одним sub одновременно: один аккаунт, счётчик 1', async () => {
  const [a, b] = await Promise.all([acc.googleAccount('same', 'a@b.co', 100), acc.googleAccount('same', 'a@b.co', 100)]);
  assert.equal(a.id, b.id); assert.equal(__raw('users'), '1');
  assert.equal(__keys().filter((k) => k.startsWith('acc:')).length, 1);
});

test('указатель gid на несуществующий аккаунт: создаётся новый аккаунт, указатель переписан', async () => {
  const ghost = 'c'.repeat(32);
  const { cmd } = await import('../api/_db.js');
  await cmd('SET', 'gid:s9', ghost); await cmd('SET', 'users', '1');
  const r = await acc.googleAccount('s9', '', 100);
  assert.equal(r.created, true); assert.notEqual(r.id, ghost); assert.equal(__raw('gid:s9'), r.id); assert.equal(__raw('users'), '2');
});

test('удаление аккаунта Google: acc, gid и данные убраны, счётчик уменьшен; новый вход создаёт другой аккаунт', async () => {
  const r = await flow();
  const cookie = pairOf(cookies(r).find((c) => c.startsWith('cb_session=')));
  const id = lib.session({ headers: { cookie } });
  const d = mockRes();
  await auth(mockReq({ method: 'POST', headers: { cookie }, body: { action: 'delete', confirm: 'удалить' } }), d);
  assert.equal(d.statusCode, 200);
  assert.equal(__raw('acc:' + id), undefined); assert.equal(__raw('gid:s1'), undefined); assert.equal(__raw('users'), '0');
  reply = null;
  const again = await flow();
  const id2 = lib.session({ headers: { cookie: pairOf(cookies(again).find((c) => c.startsWith('cb_session='))) } });
  assert.notEqual(id2, id);
});

test('удаление не трогает gid, который указывает на другой аккаунт', async () => {
  const { id } = await acc.googleAccount('s1', '', 100);
  const { cmd } = await import('../api/_db.js');
  await cmd('SET', 'gid:s1', 'd'.repeat(32));
  await acc.deleteAccount(id);
  assert.equal(__raw('gid:s1'), 'd'.repeat(32));
});

test('Telegram к аккаунту Google: привязка работает, ника нет', async () => {
  const { id } = await acc.googleAccount('s1', '', 100);
  const { token } = await acc.createLinkToken(id);
  const r = await acc.bindTelegram(token, { id: 4242, username: 'u_tg' }, 4243);
  assert.deepEqual(r, { id, nick: '' });
  assert.equal(await acc.accountOfTelegram(4242), id);
});

test('резервная копия знает вид gid (читается одной командой, в other не попадает)', () => {
  assert.equal(B.KNOWN.get('gid'), 'string');
  assert.ok(!B.TEMP.has('gid'));
});
