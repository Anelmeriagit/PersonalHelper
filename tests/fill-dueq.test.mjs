// Этап 5, переход на внешний планировщик, часть 3: скрипт scripts/fill-dueq.mjs (сухой прогон по умолчанию, --apply с подтверждением, вывод только числа).
import { test as rawTest, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __zset } from './redis.mjs';
import { setEnv, linkUser, pinMsk } from './helpers.mjs';

const test = (name, fn) => rawTest(name, (t) => { pinMsk(t, 14, 30); return fn(t); });
setEnv();
const acc = await import('../api/_acc.js');
const rem = await import('../api/_rem.js');
const db = await import('../api/_db.js');
const S = await import('../scripts/fill-dueq.mjs');

beforeEach(() => { __reset(); setEnv(); });

let tid = 9000;
async function lost() { // аккаунт с напоминанием и утерянный индекс
  const a = await linkUser(acc, 'anna', { id: ++tid, username: 'anna' });
  await rem.mutateRem(a, (r) => { r.custom.push({ id: 'aaaaaaaaaaaa', date: '2026-10-14', slot: 'h18', text: 'секретный текст', on: true, sent: false }); });
  await db.cmd('DEL', db.key('dueq'));
  return a;
}
const io = (answer) => { const out = []; return { out, confirm: async (q, w) => { out.push('?' + w); return answer === w; }, log: (s) => out.push(String(s)) }; };

test('сухой прогон по умолчанию: ничего не записывает, подтверждения не просит, в выводе нет id и текстов', async () => {
  const a = await lost();
  const i = io('REBUILD');
  assert.equal(await S.main([], i), 0);
  assert.deepEqual(__zset('dueq'), []);
  const text = i.out.join('\n');
  assert.match(text, /добавить 1, изменить 0, убрать 0/);
  assert.ok(!text.includes(a) && !text.includes(a.slice(0, 8)) && !text.includes('секретный'), text);
  assert.ok(!text.includes('?'), 'без --apply ничего не спрашивали');
});

test('--apply: без ввода REBUILD не пишет; с вводом пишет; повторный запуск — записывать нечего', async () => {
  const a = await lost();
  const no = io('нет');
  assert.equal(await S.main(['--apply'], no), 1);
  assert.deepEqual(__zset('dueq'), []);
  const yes = io('REBUILD');
  assert.equal(await S.main(['--apply'], yes), 0);
  assert.deepEqual(__zset('dueq'), [[a, rem.slotMs('2026-10-14', 'h18')]]);
  assert.ok(!yes.out.join('\n').includes(a));
  const again = io('REBUILD');
  assert.equal(await S.main(['--apply'], again), 0);
  assert.match(again.out.join('\n'), /записывать нечего/);
  assert.ok(!again.out.join('\n').includes('?'));
});

test('--apply --yes не спрашивает; --help и отсутствие Redis обрабатываются', async () => {
  const a = await lost();
  const i = io('нет');
  assert.equal(await S.main(['--apply', '--yes'], i), 0);
  assert.equal(__zset('dueq').length, 1);
  assert.equal(__zset('dueq')[0][0], a);
  assert.equal(await S.main(['--help'], io()), 0);
  const url = process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_URL;
  const j = io();
  assert.equal(await S.main([], j), 1);
  process.env.KV_REST_API_URL = url;
});
