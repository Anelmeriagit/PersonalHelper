// Этап 3b, часть 5: разовая чистка данных и дополнение множества tgs (scripts/purge-3b.mjs). Заглушки Redis (с SCAN) и Blob.
// Запуск: node --import ./tests/register.mjs --test "tests/*.test.mjs"
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __keys, __raw } from './redis.mjs';
import { __reset as resetAll, put as blobPut, __keys as blobKeys } from './blob.mjs';
import { setEnv, linkUser } from './helpers.mjs';

setEnv();
const db = await import('../api/_db.js');
const acc = await import('../api/_acc.js');
const P = await import('../scripts/purge-3b.mjs');

beforeEach(() => { resetAll(); setEnv(); });

const hex = (n) => n.toString(16).padStart(32, '0');
const A = hex(0xa1), B = hex(0xb2), C = hex(0xc3), D = hex(0xd4), E = hex(0xe5), F = hex(0xf6);

async function put(k, d = '{}') { await db.cmd('HSET', k, 'd', d, 'v', '1'); }
async function seed(ids, kinds = ['rem', 'bot', 'doc', 'agent', 'wifi']) {
  for (const id of ids) for (const kind of kinds) await put(db.key(kind, id));
}
// io для теста: журнал в массив; confirm и blob задаются тестом.
function mkIo(over = {}) {
  const lines = [];
  const asked = [];
  const io = {
    log: (s) => lines.push(s),
    confirm: async (q) => { asked.push(q); return true; },
    blob: async () => import('@vercel/blob'), // подменяется заглушкой tests/blob.mjs через hooks.mjs
    blobToken: () => 'test-blob-token',
    ...over,
  };
  return { io, lines, asked, text: () => lines.join('\n') };
}
const without = (keys, pred) => keys.filter((k) => !pred(k));

test('сухой прогон по умолчанию: считает и ничего не меняет', async () => {
  await seed([A, B, C]);
  await put('doc:abc'); // чужой вид id
  const before = __keys();
  const m = mkIo();
  const r = await P.run({}, m.io);
  assert.deepEqual(__keys(), before);
  assert.equal(r.applied, false);
  assert.deepEqual([r.plan.rem.length, r.plan.bot.length, r.plan.doc.length], [3, 3, 3]);
  assert.equal(m.asked.length, 0, 'подтверждение в сухом прогоне не спрашивается');
  assert.match(m.text(), /сухой прогон/);
  assert.match(m.text(), /doc: ключей 3 \(ещё 1 с другим видом id/);
  assert.match(m.text(), /--apply/);
});

test('--apply: удаляются только rem, bot, doc с id аккаунта; всё остальное цело', async () => {
  await seed([A, B]);
  await put('doc:abc');
  await put('t:doc:' + A); // чужой префикс в той же базе
  await put(db.key('acc', A));
  await db.cmd('SET', db.key('nick', 'anna'), A);
  await db.cmd('SET', db.key('tg', A), '{"tid":"1","chat":"1"}');
  await db.cmd('SET', db.key('tgu', '1'), A);
  await db.cmd('SADD', db.key('tgs'), A);
  const r = await P.run({ apply: true, only: ['rem', 'bot', 'doc'] }, mkIo().io);
  assert.deepEqual(r.deleted, { rem: 2, bot: 2, doc: 2 });
  assert.deepEqual(__keys(), [
    'acc:' + A, 'agent:' + A, 'agent:' + B, 'doc:abc', 'nick:anna', 't:doc:' + A, 'tg:' + A, 'tgs', 'tgu:1', 'wifi:' + A, 'wifi:' + B,
  ].sort());
  assert.deepEqual(r.skipped, []);
});

test('без подтверждения ничего не удаляется; вопрос называет число ключей и боевую базу', async () => {
  await seed([A, B]);
  const before = __keys();
  const m = mkIo({ confirm: async (q) => { m.asked.push(q); return false; } });
  const r = await P.run({ apply: true, only: ['rem', 'bot', 'doc'] }, m.io);
  assert.deepEqual(__keys(), before);
  assert.equal(r.applied, false);
  assert.equal(m.asked.length, 1);
  assert.match(m.asked[0], /Будет удалено ключей: 6/);
  assert.match(m.asked[0], /БОЕВОЙ БАЗЕ/);
  assert.match(m.text(), /Отменено/);
});

test('--yes не спрашивает подтверждение', async () => {
  await seed([A]);
  const m = mkIo();
  await P.run({ apply: true, yes: true, only: ['rem'] }, m.io);
  assert.equal(m.asked.length, 0);
  assert.equal(__raw('rem:' + A), undefined);
});

test('--only=rem: bot и doc остаются', async () => {
  await seed([A, B]);
  const r = await P.run({ apply: true, yes: true, only: ['rem'] }, mkIo().io);
  assert.deepEqual(r.deleted, { rem: 2 });
  assert.equal(without(__keys(), (k) => k.startsWith('agent:') || k.startsWith('wifi:')).join(), ['bot:' + A, 'bot:' + B, 'doc:' + A, 'doc:' + B].join());
});

test('много ключей: SCAN идёт по курсору до конца (1300 документов)', async () => {
  const ids = Array.from({ length: 1300 }, (_, i) => hex(i + 1));
  for (let i = 0; i < ids.length; i += 100) await db.pipe(ids.slice(i, i + 100).map((id) => ['HSET', db.key('doc', id), 'd', '{}', 'v', '1']));
  await put(db.key('agent', A));
  const r = await P.run({ apply: true, yes: true, only: ['doc'] }, mkIo().io);
  assert.equal(r.deleted.doc, 1300);
  assert.deepEqual(__keys(), ['agent:' + A]);
});

test('префикс со спецсимволами шаблона не раскрывается: свои ключи найдены, чужие целы', async () => {
  process.env.DB_PREFIX = 'p[1]*:';
  await put(db.key('doc', A));
  await put('p1x:doc:' + B); // подошёл бы под неэкранированный шаблон
  await put('pZZ:doc:' + C);
  const m = mkIo();
  const r = await P.run({ apply: true, yes: true, only: ['doc'] }, m.io);
  assert.equal(r.deleted.doc, 1);
  assert.deepEqual(__keys(), ['p1x:doc:' + B, 'pZZ:doc:' + C].sort());
  assert.doesNotMatch(m.text(), /боевая база/, 'префикс задан: это не боевая база');
});

test('--backfill: в tgs попадают только полные привязки; повторный запуск ничего не добавляет', async () => {
  const a = await linkUser(acc, 'anna', { id: 11 });
  const b = await linkUser(acc, 'boris', { id: 22 });
  const c = await linkUser(acc, 'clara', { id: 33 });
  const d = await linkUser(acc, 'denis', { id: 44 });
  const e = await linkUser(acc, 'elena', { id: 55 });
  // как в 3a: привязки есть, множества tgs ещё не было
  await db.del(db.key('tgs'));
  await db.cmd('SADD', db.key('tgs'), b); // b уже в множестве
  await db.del(db.key('tgu', '33')); // c: нет обратного поиска
  await db.cmd('SET', db.key('tgu', '44'), a); // d: tgu указывает на чужой аккаунт
  await db.del(db.key('acc', e)); // e: аккаунта нет
  await db.cmd('SET', db.key('tg', F), '{"tid":"66"}'); // f: нет chat
  const keysBefore = __keys().filter((k) => k !== 'tgs');

  const dry = mkIo();
  const r0 = await P.run({ backfill: true, only: ['rem'] }, dry.io);
  assert.deepEqual(r0.plan.add, [a]);
  assert.match(dry.text(), /tgs: добавить 1, уже есть 1, пропущено 4/);
  assert.deepEqual((await db.cmd('SMEMBERS', db.key('tgs'))).sort(), [b], 'сухой прогон tgs не меняет');

  const r1 = await P.run({ backfill: true, apply: true, yes: true, only: ['rem'] }, mkIo().io);
  assert.equal(r1.deleted.added, 1);
  assert.deepEqual((await db.cmd('SMEMBERS', db.key('tgs'))).sort(), [a, b].sort());
  assert.deepEqual(await acc.linkedIds(), [a, b].sort());
  assert.deepEqual(__keys().filter((k) => k !== 'tgs'), keysBefore, 'остальные ключи не тронуты');

  const r2 = await P.run({ backfill: true, apply: true, yes: true, only: ['rem'] }, mkIo().io);
  assert.deepEqual(r2.plan.add, []);
  assert.equal(r2.deleted.added, undefined);
  void c; void d; void e;
});

test('Blob: удаляется только bot/state.json, остальное остаётся и показывается', async () => {
  await blobPut('bot/state.json', '{}');
  await blobPut('agent/rows.json', '[]');
  await put(db.key('rem', A));
  const m = mkIo();
  const dry = await P.run({ only: ['blob'] }, m.io);
  assert.equal(dry.plan.blob, 1);
  assert.deepEqual(blobKeys(), ['agent/rows.json', 'bot/state.json']);
  assert.match(m.text(), /останется \(скрипт не трогает\): agent\/rows\.json/);
  const r = await P.run({ apply: true, yes: true, only: ['blob'] }, mkIo().io);
  assert.equal(r.deleted.blob, 1);
  assert.deepEqual(blobKeys(), ['agent/rows.json']);
  assert.equal(__raw('rem:' + A) !== undefined, true, 'ключи Redis без --only=rem не тронуты');
});

test('Blob: нет пакета или токена — шаг пропущен, Redis чистится, ошибка в статусе', async () => {
  await blobPut('bot/state.json', '{}');
  await seed([A], ['rem']);
  const noPkg = mkIo({ blob: async () => null });
  const r1 = await P.run({ apply: true, yes: true, only: ['rem', 'blob'] }, noPkg.io);
  assert.deepEqual(r1.skipped, ['Blob']);
  assert.match(noPkg.text(), /выполните npm i/);
  assert.equal(__raw('rem:' + A), undefined);
  const noTok = mkIo({ blobToken: () => '' });
  const r2 = await P.run({ apply: true, yes: true, only: ['blob'] }, noTok.io);
  assert.deepEqual(r2.skipped, ['Blob']);
  assert.match(noTok.text(), /BLOB_READ_WRITE_TOKEN/);
  assert.deepEqual(blobKeys(), ['bot/state.json']);
});

test('в журнал не попадают адрес и токен Redis, токен Blob и полные id', async () => {
  const a = await linkUser(acc, 'anna', { id: 11 });
  await db.del(db.key('tgs'));
  await db.cmd('SET', db.key('tg', F), '{"tid":"66"}');
  await blobPut('bot/state.json', '{}');
  await seed([A, B]);
  const m = mkIo();
  await P.run({ backfill: true, apply: true, yes: true }, m.io);
  const t = m.text() + m.asked.join('\n');
  for (const secret of [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN, 'test-blob-token']) assert.ok(!t.includes(secret), 'в журнале секрет ' + secret);
  assert.doesNotMatch(t, /[0-9a-f]{32}/, 'в журнале полный id');
  assert.match(t, new RegExp(F.slice(0, 8)), 'пропущенный аккаунт назван началом id');
  void a;
});

test('Redis не настроен: понятная ошибка, ничего не делается', async () => {
  const saved = [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN, process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN];
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try { await assert.rejects(P.run({ apply: true, yes: true }, mkIo().io), /KV_REST_API_URL и KV_REST_API_TOKEN/); }
  finally { [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN] = [saved[0], saved[1]]; }
});

test('сбой записи в Redis посреди применения: ошибка наружу, данные не удалены', async () => {
  const { __fail } = await import('./redis.mjs');
  await seed([A], ['rem']);
  __fail('write');
  await assert.rejects(P.run({ apply: true, yes: true, only: ['rem'] }, mkIo().io));
  __fail(null);
  assert.notEqual(__raw('rem:' + A), undefined);
});

test('разбор флагов: умолчания, --only, неизвестное отвергается', () => {
  assert.deepEqual(P.parseArgs([]), { apply: false, backfill: false, yes: false, only: null, help: false });
  assert.deepEqual(P.parseArgs(['--apply', '--backfill', '--only=rem,doc']), { apply: true, backfill: true, yes: false, only: ['rem', 'doc'], help: false });
  assert.throws(() => P.parseArgs(['--only=agent']), /допустимо/);
  assert.throws(() => P.parseArgs(['--only=']), /допустимо/);
  assert.throws(() => P.parseArgs(['--drop']), /неизвестный флаг/);
});
