// Соединение двух аккаунтов, часть 1 (сервер): pair-link, pair-join, pair-drop, partner в me, partnerOf/joinPair/unpair в api/_acc.js, удаление аккаунта.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __keys, __raw, __cmdLog, __drop } from './redis.mjs';
import { mockReq, mockRes, setEnv } from './helpers.mjs';

setEnv();
const auth = (await import('../api/auth.js')).default;
const acc = await import('../api/_acc.js');
const lib = await import('../api/_lib.js');
const backup = await import('../api/_backup.js');

beforeEach(() => { __reset(); setEnv(); });

async function post(cookie, body) {
  const res = mockRes();
  await auth(mockReq({ method: 'POST', headers: cookie ? { cookie, 'x-real-ip': '10.0.0.9' } : { 'x-real-ip': '10.0.0.9' }, body }), res);
  return res;
}
async function signUp(name) {
  const { id } = await acc.googleAccount('sub-' + name, '', 100);
  return { id, cookie: lib.makeCookie(id).split(';')[0] };
}
async function named(name, shown) {
  const u = await signUp(name);
  if (shown) await acc.setName(u.id, shown);
  return u;
}
const link = async (u) => (await post(u.cookie, { action: 'pair-link' })).body.token;

test('pair-link: без сессии 401; токен случайный, 22 символа, в базе только хеш, id аккаунта в ссылке нет', async () => {
  assert.equal((await post(undefined, { action: 'pair-link' })).statusCode, 401);
  const a = await signUp('anna');
  const r = await post(a.cookie, { action: 'pair-link' });
  assert.equal(r.statusCode, 200);
  assert.match(r.body.token, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(r.body.ttl, 86400);
  assert.ok(!r.body.token.includes(a.id));
  const keys = __keys();
  assert.ok(!keys.some((k) => k.includes(r.body.token)), 'токен в ключах не хранится');
  assert.ok(keys.some((k) => k.startsWith('cnt:')) && keys.includes('cnp:' + a.id));
  assert.equal((await post(a.cookie, { action: 'pair-link' })).body.token !== r.body.token, true, 'каждый раз новый');
});

test('pair-link: новая ссылка гасит прежнюю', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  const t1 = await link(a), t2 = await link(a);
  let r = await post(b.cookie, { action: 'pair-join', token: t1 });
  assert.deepEqual([r.statusCode, r.body.code], [404, 'bad']);
  assert.equal((await post(b.cookie, { action: 'pair-join', token: t2 })).statusCode, 200);
});

test('pair-join: соединяет двоих, ответ с именем давшего ссылку; связь двусторонняя, видна в me у обоих', async () => {
  const a = await named('anna', 'Анна'), b = await named('boris', 'Борис');
  const token = await link(a);
  const r = await post(b.cookie, { action: 'pair-join', token });
  assert.deepEqual([r.statusCode, r.body], [200, { partner: { linked: true, name: 'Анна' } }]);
  assert.equal(__raw('pair:' + a.id), b.id);
  assert.equal(__raw('pair:' + b.id), a.id);
  assert.deepEqual((await post(a.cookie, { action: 'me' })).body.partner, { linked: true, name: 'Борис' });
  assert.deepEqual((await post(b.cookie, { action: 'me' })).body.partner, { linked: true, name: 'Анна' });
  assert.ok(!JSON.stringify((await post(a.cookie, { action: 'me' })).body).includes(b.id), 'id партнёра сайту не отдаётся');
});

test('pair-join: ссылка одноразовая', async () => {
  const a = await signUp('anna'), b = await signUp('boris'), c = await signUp('clara');
  const token = await link(a);
  assert.equal((await post(b.cookie, { action: 'pair-join', token })).statusCode, 200);
  const r = await post(c.cookie, { action: 'pair-join', token });
  assert.deepEqual([r.statusCode, r.body.code], [404, 'bad']);
  assert.ok(!__keys().some((k) => k.startsWith('cnt:')), 'токен потрачен');
});

test('pair-join: срок ссылки: после суток недействительна', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  const token = await link(a);
  const k = __keys().find((x) => x.startsWith('cnt:'));
  __drop(k); // как истечение TTL в Redis
  const r = await post(b.cookie, { action: 'pair-join', token });
  assert.deepEqual([r.statusCode, r.body.code], [404, 'bad']);
});

test('pair-join: с самим собой нельзя, ссылка при этом остаётся годной', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  const token = await link(a);
  const r = await post(a.cookie, { action: 'pair-join', token });
  assert.deepEqual([r.statusCode, r.body.code], [400, 'self']);
  assert.ok(!__keys().some((k) => k.startsWith('pair:')));
  assert.equal((await post(b.cookie, { action: 'pair-join', token })).statusCode, 200);
});

test('pair-join: только два аккаунта: у кого связь уже есть, ссылку не примет и не выдаст', async () => {
  const a = await signUp('anna'), b = await signUp('boris'), c = await signUp('clara');
  assert.equal((await post(b.cookie, { action: 'pair-join', token: await link(a) })).statusCode, 200);
  // третий не может получить ссылку у соединённого
  let r = await post(a.cookie, { action: 'pair-link' });
  assert.deepEqual([r.statusCode, r.body.code], [409, 'paired']);
  // соединённый не может принять чужую ссылку (и она не сгорает)
  const tc = await link(c);
  r = await post(b.cookie, { action: 'pair-join', token: tc });
  assert.deepEqual([r.statusCode, r.body.code], [409, 'mine']);
  assert.ok(__keys().some((k) => k.startsWith('cnt:')), 'ссылка не потрачена');
  // давший ссылку успел соединиться с другим до того, как по ссылке пришли
  const d = await signUp('dina'), e = await signUp('egor'), f = await signUp('fedor');
  const td = await link(d);
  await acc.unpair(d.id);
  const te = await link(e);
  assert.equal((await post(d.cookie, { action: 'pair-join', token: te })).statusCode, 200);
  r = await post(f.cookie, { action: 'pair-join', token: td });
  assert.ok(r.statusCode === 404 || r.statusCode === 409, 'ссылка Дины уже не работает');
  assert.equal(__raw('pair:' + f.id), undefined);
  assert.equal(__raw('pair:' + e.id), d.id);
});

test('pair-join: мусор вместо токена: 404 без обращения к парам; без сессии 401; лимит попыток 429', async () => {
  const b = await signUp('boris');
  for (const token of [undefined, null, 5, {}, '', 'x', 'a'.repeat(22), 'a'.repeat(200), '../etc']) {
    const r = await post(b.cookie, { action: 'pair-join', token });
    assert.equal(r.statusCode, 404, String(token));
  }
  assert.equal((await post(undefined, { action: 'pair-join', token: 'a'.repeat(22) })).statusCode, 401);
  __reset(); setEnv();
  const c = await signUp('clara');
  let last;
  for (let i = 0; i < 11; i++) last = await post(c.cookie, { action: 'pair-join', token: 'a'.repeat(22) });
  assert.equal(last.statusCode, 429);
});

test('pair-link: не больше 5 новых ссылок за 10 минут', async () => {
  const a = await signUp('anna');
  let last;
  for (let i = 0; i < 6; i++) last = await post(a.cookie, { action: 'pair-link' });
  assert.equal(last.statusCode, 429);
});

test('pair-drop: разрывает у обоих, идемпотентно; после разрыва можно соединиться заново с другим', async () => {
  const a = await named('anna', 'Анна'), b = await signUp('boris'), c = await signUp('clara');
  await post(b.cookie, { action: 'pair-join', token: await link(a) });
  let r = await post(b.cookie, { action: 'pair-drop' });
  assert.deepEqual([r.statusCode, r.body], [200, { partner: { linked: false } }]);
  assert.ok(!__keys().some((k) => k.startsWith('pair:')));
  assert.deepEqual((await post(a.cookie, { action: 'me' })).body.partner, { linked: false });
  assert.equal((await post(a.cookie, { action: 'pair-drop' })).statusCode, 200, 'повтор безвреден');
  assert.equal((await post(undefined, { action: 'pair-drop' })).statusCode, 401);
  assert.equal((await post(c.cookie, { action: 'pair-join', token: await link(a) })).statusCode, 200);
});

test('partnerOf: оборванная половинка партнёром не считается и не мешает новой связи', async () => {
  const a = await signUp('anna'), b = await signUp('boris'), c = await signUp('clara');
  const { cmd, key } = await import('../api/_db.js');
  await cmd('SET', key('pair', a.id), b.id); // без ответной записи
  assert.equal(await acc.partnerOf(a.id), null);
  assert.deepEqual((await post(a.cookie, { action: 'me' })).body.partner, { linked: false });
  assert.equal((await post(c.cookie, { action: 'pair-join', token: await link(a) })).statusCode, 200);
  assert.equal(await acc.partnerOf(a.id), c.id);
  // чужой id в теле игнорируется: рвётся связь вызывающего
  await post(b.cookie, { action: 'pair-drop', id: a.id });
  assert.equal(await acc.partnerOf(a.id), c.id);
});

test('удаление аккаунта разрывает связь, ключи пары, лимиты и ссылку убираются', async () => {
  const a = await named('anna', 'Анна'), b = await signUp('boris');
  await post(b.cookie, { action: 'pair-join', token: await link(a) });
  await link(b).catch(() => {}); // у соединённого ссылки нет
  const x = await post(a.cookie, { action: 'delete', confirm: 'удалить' });
  assert.equal(x.statusCode, 200);
  assert.ok(!__keys().some((k) => k.includes(a.id)), 'ключей удалённого аккаунта не осталось: ' + __keys().filter((k) => k.includes(a.id)));
  assert.deepEqual((await post(b.cookie, { action: 'me' })).body.partner, { linked: false });
  assert.equal(__raw('pair:' + b.id), undefined);
});

test('расход команд: me без связи, pair-link, pair-join', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  __cmdLog(true);
  await post(a.cookie, { action: 'me' });
  const meCmds = __cmdLog().length;
  __cmdLog(true);
  const token = await link(a);
  const linkCmds = __cmdLog().length;
  __cmdLog(true);
  await post(b.cookie, { action: 'pair-join', token });
  const joinCmds = __cmdLog().length;
  assert.ok(meCmds <= 6, 'me: ' + meCmds);
  assert.ok(linkCmds <= 9, 'pair-link: ' + linkCmds);
  assert.ok(joinCmds <= 17, 'pair-join: ' + joinCmds);
});

test('резервная копия: pair копируется, cnt и cnp нет', async () => {
  const a = await signUp('anna'), b = await signUp('boris');
  await post(b.cookie, { action: 'pair-join', token: await link(a) });
  await link(b).catch(() => {});
  assert.equal(backup.KNOWN.get('pair'), 'string');
  assert.ok(backup.TEMP.has('cnt') && backup.TEMP.has('cnp'));
});
