// Аккаунт, этап 5: me, rename, delete в api/auth.js, name в GET /api/data, setName/deleteAccount в api/_acc.js.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __keys, __raw, __fail, __after, __drop } from './redis.mjs';
import { mockReq, mockRes, setEnv, linkUser } from './helpers.mjs';

setEnv();
const auth = (await import('../api/auth.js')).default;
const data = (await import('../api/data.js')).default;
const acc = await import('../api/_acc.js');
const lib = await import('../api/_lib.js');

beforeEach(() => { __reset(); setEnv(); });

const cookieOf = (res) => String(res.headers['set-cookie']).split(';')[0];
async function call(fn, { method = 'POST', body, cookie } = {}) {
  const res = mockRes();
  await fn(mockReq({ method, headers: cookie ? { cookie, 'x-real-ip': '10.0.0.9' } : { 'x-real-ip': '10.0.0.9' }, body }), res);
  return res;
}
async function signUp(name) {
  const { id } = await acc.googleAccount('sub-' + name, '', 100);
  return { cookie: lib.makeCookie(id).split(';')[0], id };
}
const post = (cookie, body) => call(auth, { cookie, body });
const keysOf = (id) => __keys().filter((k) => k.includes(id));

/* ---------- me ---------- */
test('me без сессии и с чужой подписью: 401', async () => {
  assert.equal((await post(undefined, { action: 'me' })).statusCode, 401);
  assert.equal((await post('cb_session=abc.def', { action: 'me' })).statusCode, 401);
});

test('me: id, пустое имя и пустой email (у аккаунта Google без подтверждённой почты), Telegram не привязан', async () => {
  const { cookie, id } = await signUp('anna');
  const r = await post(cookie, { action: 'me' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { id, name: '', email: '', tg: { linked: false } });
  assert.ok(!JSON.stringify(r.body).includes('pw'));
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('me: привязанный Telegram даёт tid и имя, без chat', async () => {
  const { cookie, id } = await signUp('anna');
  const { token } = await acc.createLinkToken(id);
  await acc.bindTelegram(token, { id: 777, username: 'anna_tg' }, 5551);
  const r = await post(cookie, { action: 'me' });
  assert.deepEqual(r.body.tg, { linked: true, id: '777', username: 'anna_tg' });
  assert.ok(!JSON.stringify(r.body).includes('5551'));
});

/* ---------- rename ---------- */
test('rename: пробелы схлопываются, управляющие символы убираются, не больше 32 символов, запись видна в me и data', async () => {
  const { cookie, id } = await signUp('anna');
  let r = await post(cookie, { action: 'rename', name: '  Анна \t\n  Кузнецова\u0000 ' });
  assert.deepEqual([r.statusCode, r.body], [200, { name: 'Анна Кузнецова' }]);
  assert.equal((await post(cookie, { action: 'me' })).body.name, 'Анна Кузнецова');
  const g = await call(data, { method: 'GET', cookie });
  assert.equal(g.body.name, 'Анна Кузнецова');
  assert.ok(!('user' in g.body), 'никнейма в ответе нет');
  r = await post(cookie, { action: 'rename', name: 'ж'.repeat(40) });
  assert.equal(r.body.name, 'ж'.repeat(32));
  r = await post(cookie, { action: 'rename', name: '😀'.repeat(40) });
  assert.equal(Array.from(r.body.name).length, 32, 'считаются символы, а не половинки суррогатов');
  assert.ok(!/[\ud800-\udfff]/.test(r.body.name.replace(/[\ud83d][\ude00]/g, '')), 'нет оборванных половинок');
  const stored = JSON.parse(__raw('acc:' + id));
  assert.equal(stored.gsub, 'sub-anna', 'указатель на аккаунт Google сохранён');
  assert.ok(!('id' in stored), 'id в записи не хранится');
  assert.ok(!('nick' in stored) && !('pw' in stored), 'ни никнейма, ни пароля');
});

test('rename: пустое имя и имя из одних пробелов сбрасывают поле; не строка: 400', async () => {
  const { cookie, id } = await signUp('anna');
  await post(cookie, { action: 'rename', name: 'Анна' });
  assert.equal(JSON.parse(__raw('acc:' + id)).name, 'Анна');
  const r = await post(cookie, { action: 'rename', name: ' \n ' });
  assert.deepEqual(r.body, { name: '' });
  assert.ok(!('name' in JSON.parse(__raw('acc:' + id))));
  for (const bad of [undefined, null, 5, {}, ['a']]) {
    assert.equal((await post(cookie, { action: 'rename', name: bad })).statusCode, 400);
  }
});

test('rename: без сессии 401; чужой id в теле игнорируется; удалённый аккаунт заново не создаётся', async () => {
  assert.equal((await post(undefined, { action: 'rename', name: 'x' })).statusCode, 401);
  const a = await signUp('anna'), b = await signUp('boris');
  await post(a.cookie, { action: 'rename', name: 'Анна', id: b.id });
  assert.ok(!('name' in JSON.parse(__raw('acc:' + b.id))));
  await acc.deleteAccount(a.id);
  const r = await post(a.cookie, { action: 'rename', name: 'Призрак' });
  assert.equal(r.statusCode, 401);
  assert.equal(__raw('acc:' + a.id), undefined, 'XX: запись не воскресла');
});

test('setName: аккаунт удалён между чтением и записью (SET ... XX): запись не воскресает', async () => {
  const { id } = await signUp('anna');
  __after('GET', () => __drop('acc:' + id));
  assert.equal(await acc.setName(id, 'Призрак'), null);
  assert.equal(__raw('acc:' + id), undefined);
});

test('без cookie id из тела запроса не даёт ничего: me, rename, delete → 401', async () => {
  const { id } = await signUp('anna');
  for (const b of [{ action: 'me' }, { action: 'rename', name: 'x' }, { action: 'delete', confirm: 'удалить' }]) {
    assert.equal((await post(undefined, { ...b, id, user: id })).statusCode, 401);
  }
  assert.ok(__raw('acc:' + id));
});

test('data GET: поле name есть всегда (пустая строка, если имя не задано)', async () => {
  const { cookie } = await signUp('anna');
  const g = await call(data, { method: 'GET', cookie });
  assert.equal(g.statusCode, 200);
  assert.equal(g.body.name, '');
});

/* ---------- delete ---------- */
async function fill(id, cookie) {
  await lib.writeRec('wifi', id, { ssid: 'Net', password: 'secret-pw' }, null);
  await lib.writeRec('agent', id, { rows: [] }, null);
  await lib.writeDoc(id, { months: {}, custom: [], rev: {} }, null);
  await lib.writeRec('rem', id, { v: 1 }, null);
  await lib.writeRec('bot', id, { alias: {} }, null);
}

test('delete: без слова или с чужим словом 400 и ничего не удалено; без сессии 401', async () => {
  const { cookie, id } = await signUp('anna');
  const before = __keys();
  for (const confirm of [undefined, '', 'delete', 'удалить аккаунт', 5]) {
    assert.equal((await post(cookie, { action: 'delete', confirm })).statusCode, 400);
  }
  assert.deepEqual(__keys(), before);
  assert.equal((await post(undefined, { action: 'delete', confirm: 'удалить' })).statusCode, 401);
  assert.ok(__raw('acc:' + id));
});

test('delete: слово в любом регистре и с пробелами; удалены все ключи аккаунта и Telegram, чужой аккаунт цел, счётчик и cookie', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  await fill(a.id, a.cookie);
  await fill(b.id, b.cookie);
  const tA = await linkUser(acc, 'viktor', { id: 41, username: 'v' });
  const { token } = await acc.createLinkToken(a.id);
  await acc.bindTelegram(token, { id: 42, username: 'anna_tg' }, 4201);
  await acc.createLinkToken(a.id); // tgp и tgt
  const keepB = keysOf(b.id).length, keepV = keysOf(tA).length;
  assert.equal(__raw('users'), '3');

  const r = await post(a.cookie, { action: 'delete', confirm: '  УДАЛИТЬ ' });
  assert.deepEqual([r.statusCode, r.body], [200, { ok: true }]);
  assert.match(r.headers['set-cookie'], /Max-Age=0/);
  assert.deepEqual(keysOf(a.id), [], 'ни одного ключа аккаунта');
  assert.equal(__raw('gid:sub-anna'), undefined);
  assert.equal(__raw('tgu:42'), undefined);
  assert.ok(!(__raw('tgs') || []).includes(a.id));
  assert.equal(__raw('users'), '2');
  assert.equal(keysOf(b.id).length, keepB);
  assert.equal(keysOf(tA).length, keepV);
  assert.ok((__raw('tgs') || []).includes(tA), 'Telegram чужого аккаунта привязан');
  assert.equal(__raw('tgu:41'), tA);
  // сессия мертва; тот же Google-аккаунт при новом входе создаётся заново, с другим id
  assert.equal((await call(data, { method: 'GET', cookie: a.cookie })).statusCode, 401);
  assert.equal((await post(a.cookie, { action: 'me' })).statusCode, 401);
  const again = await acc.googleAccount('sub-anna', '', 100);
  assert.equal(again.created, true);
  assert.notEqual(again.id, a.id);
});

test('delete: устаревший аккаунт с никнеймом и паролем (до отказа от входа по паролю): ключ nick тоже убирается, чужой nick остаётся', async () => {
  const { cmd } = await import('../api/_db.js');
  const id = 'e'.repeat(32), other = 'f'.repeat(32);
  await cmd('SET', 'acc:' + id, JSON.stringify({ nick: 'old', pw: 'x:y', at: 1 }));
  await cmd('SET', 'nick:old', id);
  await cmd('SET', 'acc:' + other, JSON.stringify({ nick: 'two', pw: 'x:y', at: 1 }));
  await cmd('SET', 'nick:two', id); // указывает не на свой аккаунт
  await cmd('SET', 'users', '2');
  assert.equal(await acc.deleteAccount(id), true);
  assert.equal(__raw('nick:old'), undefined);
  assert.equal(__raw('acc:' + id), undefined);
  assert.equal(__raw('users'), '1');
  assert.equal(await acc.deleteAccount(other), true);
  assert.equal(__raw('nick:two'), id, 'чужой указатель не трогаем');
});

test('delete: id берётся из cookie, поле id в теле не работает', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  await post(a.cookie, { action: 'delete', confirm: 'удалить', id: b.id });
  assert.ok(__raw('acc:' + b.id));
  assert.equal(__raw('acc:' + a.id), undefined);
});

test('delete: сбой посередине: запись acc осталась, повтор дочищает (счётчик уменьшается один раз)', async () => {
  const a = await signUp('anna');
  await fill(a.id, a.cookie);
  __fail('write', 'doc:');
  const bad = await post(a.cookie, { action: 'delete', confirm: 'удалить' });
  assert.equal(bad.statusCode, 503);
  assert.ok(__raw('acc:' + a.id), 'пока не всё удалено, аккаунт есть: сессия рабочая');
  assert.equal(__raw('users'), '1');
  __fail(null);
  const ok = await post(a.cookie, { action: 'delete', confirm: 'удалить' });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(keysOf(a.id), []);
  assert.equal(__raw('users'), '0');
  assert.equal((await post(a.cookie, { action: 'delete', confirm: 'удалить' })).statusCode, 401, 'повтор после удаления: сессии нет');
  assert.equal(__raw('users'), '0', 'счётчик не ушёл в минус');
});

test('действия с сессией на ненастроенном сервере: 500', async () => {
  const { cookie } = await signUp('anna');
  const s = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  assert.equal((await post(cookie, { action: 'me' })).statusCode, 500);
  process.env.SESSION_SECRET = s;
});
