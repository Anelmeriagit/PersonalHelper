// Гостевой режим, часть 3: чистка аккаунтов с паролем (scripts/purge-pw.mjs). Заглушка Redis (с SCAN).
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __keys } from './redis.mjs';
import { setEnv, linkUser, mkAccount } from './helpers.mjs';

setEnv();
const db = await import('../api/_db.js');
const acc = await import('../api/_acc.js');
const P = await import('../scripts/purge-pw.mjs');

beforeEach(() => { __reset(); setEnv(); });

const hex = (n) => n.toString(16).padStart(32, '0');
const A = hex(0xa1), B = hex(0xb2);
const NICKS = { [A]: 'ownerNick', [B]: 'zhannaNick' };

async function hput(k) { await db.cmd('HSET', k, 'd', '{}', 'v', '1'); }
// аккаунт старого образца: пароль и никнейм (значение pw условное, не настоящее), личные данные, привязка Telegram
async function oldAcc(id, tg) {
  await db.cmd('SET', db.key('acc', id), JSON.stringify({ nick: NICKS[id], pw: 'x:y', at: 1 }));
  await db.cmd('SET', db.key('nick', NICKS[id]), id);
  await db.cmd('INCR', db.key('users'));
  for (const kind of ['doc', 'rem', 'agent', 'wifi', 'bot']) await hput(db.key(kind, id));
  if (tg) {
    await db.cmd('SET', db.key('tg', id), JSON.stringify({ tid: String(tg), chat: String(tg), un: '', at: 1 }));
    await db.cmd('SET', db.key('tgu', String(tg)), id);
    await db.cmd('SADD', db.key('tgs'), id);
  }
}
function mkIo(over = {}) {
  const lines = [], asked = [];
  return { io: { log: (s) => lines.push(s), confirm: async (q) => { asked.push(q); return true; }, ...over }, lines, asked, text: () => lines.join('\n') };
}
const users = async () => Number(await db.cmd('GET', db.key('users')));

test('сухой прогон: считает, ничего не меняет, в выводе нет никнеймов и полных id', async () => {
  await oldAcc(A, 111); await oldAcc(B);
  const g = await mkAccount(acc, 'g1');
  await db.cmd('SET', db.key('acc', 'abc'), '{}'); // чужой вид id
  const before = __keys();
  const m = mkIo();
  const r = await P.run({}, m.io);
  assert.deepEqual(__keys(), before);
  assert.equal(r.applied, false);
  assert.deepEqual(r.plan.pw, [A, B]);
  assert.equal(r.plan.google, 1);
  assert.equal(m.asked.length, 0, 'в сухом прогоне подтверждение не спрашивается');
  const t = m.text();
  assert.match(t, /сухой прогон/);
  assert.match(t, /с паролем: 2, Google: 1/);
  assert.match(t, /--apply/);
  for (const id of [A, B, g]) assert.ok(!t.includes(id), 'полный id в выводе');
  for (const n of Object.values(NICKS)) assert.ok(!t.includes(n), 'никнейм в выводе');
  assert.ok(t.includes(A.slice(0, 8)) && t.includes(B.slice(0, 8)), 'начало id есть');
});

test('--apply без подтверждения ничего не меняет, вопрос требует DELETE', async () => {
  await oldAcc(A);
  const before = __keys();
  const m = mkIo({ confirm: async (q) => { m.asked.push(q); return false; } });
  const r = await P.run({ apply: true }, m.io);
  assert.equal(r.applied, false);
  assert.deepEqual(__keys(), before);
  assert.match(m.asked[0], /DELETE/);
  assert.match(m.text(), /Отменено/);
});

test('--apply: аккаунты с паролем удалены со всеми данными, Google-аккаунт и его данные целы', async () => {
  await oldAcc(A, 111); await oldAcc(B);
  const gid = await linkUser(acc, 'g1', { id: 222, username: 'gg' });
  for (const kind of ['doc', 'rem', 'agent', 'wifi', 'bot']) await hput(db.key(kind, gid));
  assert.equal(await users(), 3);
  const m = mkIo();
  const r = await P.run({ apply: true }, m.io);
  assert.equal(r.applied, true);
  assert.equal(r.deleted, 2);
  assert.deepEqual(r.skipped, []);
  const left = __keys();
  for (const id of [A, B]) assert.ok(!left.some((k) => k.includes(id)), 'ключи удалённого аккаунта остались: ' + id.slice(0, 8));
  for (const n of Object.values(NICKS)) assert.ok(!left.includes('nick:' + n), 'ключ никнейма остался');
  assert.ok(!left.includes('tgu:111'), 'обратный поиск Telegram остался');
  assert.deepEqual((await db.cmd('SMEMBERS', db.key('tgs'))).sort(), [gid]);
  assert.ok(left.includes('acc:' + gid) && left.includes('tg:' + gid) && left.includes('tgu:222'), 'аккаунт Google затронут');
  for (const kind of ['doc', 'rem', 'agent', 'wifi', 'bot']) assert.ok(left.includes(kind + ':' + gid), kind + ' аккаунта Google удалён');
  assert.equal(await users(), 1, 'счётчик users уменьшен на два');
  const t = m.text();
  for (const n of Object.values(NICKS)) assert.ok(!t.includes(n));
  assert.ok(!t.includes(A) && !t.includes(B));
  assert.match(t, /удалено 2, с паролем осталось 0/);
  // повторный запуск: делать нечего
  const again = mkIo();
  const r2 = await P.run({ apply: true }, again.io);
  assert.equal(r2.deleted, 0);
  assert.equal(again.asked.length, 0);
  assert.match(again.text(), /Делать нечего/);
  assert.equal(await users(), 1);
});

test('аккаунт с gsub не удаляется, даже если в записи остались pw или nick; нечитаемые записи только считаются', async () => {
  const mixed = hex(0xc3), junk = hex(0xd4), blank = hex(0xe5);
  await db.cmd('SET', db.key('acc', mixed), JSON.stringify({ gsub: 'sub-1', nick: 'old', pw: 'x:y' }));
  await db.cmd('SET', db.key('acc', junk), 'не JSON');
  await db.cmd('SET', db.key('acc', blank), '{}');
  const before = __keys();
  const m = mkIo();
  const r = await P.run({ apply: true, yes: true }, m.io);
  assert.deepEqual(r.plan.pw, []);
  assert.equal(r.plan.google, 1);
  assert.equal(r.plan.other, 2);
  assert.deepEqual(__keys(), before);
  assert.equal(m.asked.length, 0);
});

test('ключи nick без аккаунта только считаются, не удаляются', async () => {
  await db.cmd('SET', db.key('nick', 'ghost'), hex(0x99));
  const before = __keys();
  const m = mkIo();
  await P.run({ apply: true }, m.io);
  assert.deepEqual(__keys(), before);
  assert.match(m.text(), /ключей nick: 1, из них без аккаунта: 1/);
  assert.ok(!m.text().includes('ghost'));
});

test('--yes не спрашивает подтверждение; флаги разбираются строго', async () => {
  await oldAcc(A);
  const m = mkIo();
  await P.run({ apply: true, yes: true }, m.io);
  assert.equal(m.asked.length, 0);
  assert.ok(!__keys().some((k) => k.includes(A)));
  assert.deepEqual(P.parseArgs([]), { apply: false, yes: false, help: false });
  assert.deepEqual(P.parseArgs(['--apply', '--yes']), { apply: true, yes: true, help: false });
  assert.throws(() => P.parseArgs(['--backfill']), /неизвестный флаг/);
});
