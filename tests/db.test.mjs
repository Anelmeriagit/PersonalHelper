// Слой хранения api/_db.js на заглушке Redis (tests/redis.mjs).
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __keys, __fail, __raw } from './redis.mjs';
import { setEnv, fakeClock } from './helpers.mjs';

setEnv();
const db = await import('../api/_db.js');

beforeEach(() => { __reset(); setEnv(); });

test('prefix: пусто, "1", "t:" и пробелы нормализуются; key() их применяет', async () => {
  assert.equal(db.prefix(), '');
  assert.equal(db.key('doc', 'abc'), 'doc:abc');
  process.env.DB_PREFIX = '1'; assert.equal(db.key('doc', 'abc'), '1:doc:abc');
  process.env.DB_PREFIX = 't:'; assert.equal(db.key('doc', 'abc'), 't:doc:abc');
  process.env.DB_PREFIX = ' t '; assert.equal(db.key('x'), 't:x');
  await db.cmd('SET', db.key('k'), 'v');
  assert.deepEqual(__keys(), ['t:k']);
});

test('cmd/pipe: базовые команды и ошибки команд', async () => {
  assert.equal(await db.cmd('SET', 'a', 'x'), 'OK');
  assert.equal(await db.cmd('GET', 'a'), 'x');
  assert.deepEqual(await db.pipe([['GET', 'a'], ['GET', 'нет']]), ['x', null]);
  await assert.rejects(db.cmd('INCR', 'a'), (e) => e.name === 'DbError' && e.kind === 'http' && /not an integer/.test(e.message));
  await assert.rejects(db.pipe([['GET', 'a'], ['INCR', 'a']]), (e) => e.kind === 'cmd');
});

test('настройка: без KV_* dbReady=false и ошибка config; запасные имена UPSTASH_* работают', async () => {
  const url = process.env.KV_REST_API_URL, tok = process.env.KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  assert.equal(db.dbReady(), false);
  await assert.rejects(db.cmd('GET', 'a'), (e) => e.kind === 'config');
  process.env.UPSTASH_REDIS_REST_URL = url; process.env.UPSTASH_REDIS_REST_TOKEN = tok;
  assert.equal(db.dbReady(), true);
  assert.equal(await db.cmd('SET', 'a', '1'), 'OK');
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.KV_REST_API_URL = url; process.env.KV_REST_API_TOKEN = tok;
});

test('сбои: сеть и HTTP 500 дают DbError; токен и адрес в сообщение не попадают; чужой токен отвергается', async () => {
  __fail('network');
  await assert.rejects(db.cmd('GET', 'a'), (e) => e.kind === 'network' && !e.message.includes(process.env.KV_REST_API_TOKEN) && !e.message.includes('redis.test'));
  __fail('http');
  await assert.rejects(db.cmd('GET', 'a'), (e) => e.kind === 'http' && /500/.test(e.message));
  __fail(null);
  const tok = process.env.KV_REST_API_TOKEN;
  process.env.KV_REST_API_TOKEN = 'wrong-token';
  await assert.rejects(db.cmd('GET', 'a'), (e) => e.kind === 'http' && /401/.test(e.message) && !e.message.includes('wrong-token'));
  process.env.KV_REST_API_TOKEN = tok;
});

test('getDoc/putDoc: создание, конфликт версий, обновление, содержимое не портится', async () => {
  assert.deepEqual(await db.getDoc('d'), { doc: null, v: 0 });
  const obj = { months: {}, custom: ['Моя "кат"', "и'о", 'a\\b'], rev: { custom: 3 } };
  assert.equal(await db.putDoc('d', obj, 0), 1);
  assert.equal(await db.putDoc('d', { x: 1 }, 0), null, 'повторное создание при существующем документе');
  assert.deepEqual(await db.getDoc('d'), { doc: obj, v: 1 });
  assert.equal(await db.putDoc('d', { x: 2 }, 1), 2);
  assert.equal(await db.putDoc('d', { x: 3 }, 1), null, 'устаревшая версия');
  assert.deepEqual(await db.getDoc('d'), { doc: { x: 2 }, v: 2 });
  assert.equal(await db.putDoc('d', { x: 4 }), null, 'без версии = «документа ещё нет»');
});

test('putDoc: две параллельные записи с одной версией: проходит ровно одна', async () => {
  const r = await Promise.all([db.putDoc('p', { a: 1 }, 0), db.putDoc('p', { a: 2 }, 0)]);
  assert.deepEqual(r.map((x) => x === null).sort(), [false, true]);
});

test('hit/count: счёт, окно не продлевается повторными попытками, истечение', async (t) => {
  const clock = fakeClock(t);
  const W = 10 * 60 * 1000;
  assert.deepEqual(await db.count('h'), { n: 0, ttl: 0 });
  assert.equal(await db.hit('h', W), 1);
  clock.advance(W * 0.6);
  assert.equal(await db.hit('h', W), 2);
  const c = await db.count('h');
  assert.equal(c.n, 2);
  assert.ok(c.ttl > 0 && c.ttl <= W * 0.4 + 5, 'ttl считается от первой попытки: ' + c.ttl);
  clock.advance(W * 0.5);
  assert.deepEqual(await db.count('h'), { n: 0, ttl: 0 });
  assert.equal(await db.hit('h', W), 1);
});

test('setNx и del', async () => {
  assert.equal(await db.setNx('n', 'a'), true);
  assert.equal(await db.setNx('n', 'b'), false);
  assert.equal(__raw('n'), 'a');
  assert.equal(await db.del('n', 'нет'), 1);
  assert.equal(await db.setNx('n', 'c'), true);
});

test('скрипты Lua начинаются с маркеров, по которым их узнаёт заглушка', () => {
  assert.ok(db.CAS.startsWith('-- cas'));
  assert.ok(db.HIT.startsWith('-- hit'));
});
