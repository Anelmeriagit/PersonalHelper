// Скрипт scripts/export-shops.mjs: выгрузка новых магазинов из личных псевдонимов бота (только чтение, в выводе нет id).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __reset, __keys } from './redis.mjs';
import { setEnv } from './helpers.mjs';

setEnv();
const bot = await import('../api/_bot.js');
const X = await import('../scripts/export-shops.mjs');

beforeEach(() => { __reset(); setEnv(); });

const NOW = 1_760_000_000_000;
const A = (c, t) => ({ c, t, at: NOW });
const io = () => { const out = []; const saved = {}; return { out, saved, log: (s) => out.push(String(s)), save: (n, t) => { if (saved[n]) { const e = new Error('x'); e.code = 'EEXIST'; throw e; } saved[n] = t; } }; };

async function seed() {
  const set = (id, alias) => bot.mutateBot(id, (s) => { Object.assign(s.alias, alias); });
  await set('acc-secret-1', { 'zzqx магазин': A('Супермаркеты', 'ZZQX магазин'), pyaterochka: A('Супермаркеты', 'Pyaterochka'), пятерочка: A('Фастфуд', 'Пятёрочка'), 'моя кат': A('Моя категория', 'Х'), супермаркеты: A('Супермаркеты', 'Супермаркеты') });
  await set('acc-secret-2', { 'zzqx магазин': A('Супермаркеты', 'Zzqx Магазин'), 'zzqx магазин ': A('Супермаркеты', 'Zzqx Магазин'), пятерочка: A('Фастфуд', 'Пятёрочка') });
  await set('acc-secret-3', { 'zzqx магазин': A('Супермаркеты', 'Zzqx Магазин'), 'o\'brien': A('Кафе и рестораны', "O'Brien") });
  await set('acc-secret-4', {}); // без псевдонимов
}

test('раскладка: новые, алиасы, исправления, свои категории, пропуск', () => {
  const rep = X.layout([
    { u: 1, key: 'zzqx магазин', c: 'Супермаркеты', t: 'Zzqx' },
    { u: 2, key: 'zzqx магазин', c: 'Супермаркеты', t: 'Zzqx' },
    { u: 3, key: 'zzqx магазин', c: 'Супермаркеты', t: 'Другое' },
    { u: 1, key: 'pyaterochka', c: 'Супермаркеты', t: 'P' },
    { u: 1, key: 'пятерочка', c: 'Фастфуд', t: 'Пятёрочка' },
    { u: 1, key: 'пятерочка', c: 'Супермаркеты', t: 'Пятёрочка' }, // совпало со словарём
    { u: 2, key: 'моя', c: 'Моя категория', t: 'М' },
    { u: 2, key: 'супермаркеты', c: 'Супермаркеты', t: '' }, // сама категория
    { u: 2, key: '', c: 'Фастфуд', t: '' },
    { u: 2, key: 'abc', c: null, t: '' },
  ]);
  assert.equal(rep.total, 10);
  assert.deepEqual(rep.fresh, [{ title: 'Zzqx', cat: 'Супермаркеты', key: 'zzqx магазин', n: 3 }]);
  assert.deepEqual(rep.known, [{ shop: 'Пятёрочка', key: 'pyaterochka', n: 1 }]);
  assert.deepEqual(rep.fixes, [{ shop: 'Пятёрочка', dict: 'Супермаркеты', cat: 'Фастфуд', n: 1 }]);
  assert.deepEqual(rep.foreign, [{ cat: 'Моя категория', n: 1, aliases: 1 }]);
  assert.equal(rep.skipped, 4);
});

test('render: готовые строки SHOPS, кавычки экранируются, порог --min', () => {
  const rep = X.layout([
    { u: 1, key: "o'brien", c: 'Кафе и рестораны', t: "O'Brien\nпаб" },
    { u: 2, key: 'zzqx магазин', c: 'Супермаркеты', t: 'Zzqx' },
    { u: 3, key: 'zzqx магазин', c: 'Супермаркеты', t: 'Zzqx' },
  ]);
  const all = X.render(rep, { min: 1, accounts: 3 });
  assert.match(all, /\['Zzqx', 'Супермаркеты', \[\]\], \/\/ аккаунтов: 2/);
  assert.match(all, /\['O\\'Brien паб', 'Кафе и рестораны', \[\]\], \/\/ аккаунтов: 1/);
  assert.ok(all.indexOf('  // Кафе и рестораны') < all.indexOf('  // Супермаркеты'), 'порядок CATS');
  const two = X.render(rep, { min: 2, accounts: 3 });
  assert.ok(!two.includes('Brien') && two.includes('Zzqx') && /скрыто порогом --min: 1 групп/.test(two));
});

test('parseArgs: --min, --out (оба вида), ошибки', () => {
  assert.deepEqual(X.parseArgs([]), { min: 1, out: '', help: false });
  assert.deepEqual(X.parseArgs(['--min=3', '--out', 'a.txt']), { min: 3, out: 'a.txt', help: false });
  assert.equal(X.parseArgs(['--out=a.txt']).out, 'a.txt');
  for (const bad of [['--min=0'], ['--min=x'], ['--out=../a.txt'], ['--out=sub/a.txt'], ['--out='], ['--apply']]) assert.ok(X.parseArgs(bad).error, bad.join(' '));
});

test('main: читает bot:*, ничего не пишет, в выводе нет id, --out пишет файл и не перезаписывает', async () => {
  await seed();
  const before = JSON.stringify(__keys().sort());
  const i = io();
  assert.equal(await X.main(['--out=s.txt'], i), 0);
  const text = i.out.join('\n');
  assert.match(text, /аккаунтов с псевдонимами 3, псевдонимов 10/);
  assert.match(text, /\['Zzqx Магазин', 'Супермаркеты', \[\]\], \/\/ аккаунтов: 3/);
  assert.match(text, /Пятёрочка: 'pyaterochka' \(аккаунтов: 1\)/);
  assert.match(text, /Пятёрочка: в словаре «Супермаркеты», выбрано «Фастфуд» \(аккаунтов: 2\)/);
  assert.match(text, /Моя категория: аккаунтов 1, псевдонимов 1/);
  assert.ok(!text.includes('acc-secret'), 'id аккаунтов не печатаются');
  assert.ok(i.saved['s.txt'].includes('Zzqx Магазин') && !i.saved['s.txt'].includes('acc-secret'));
  assert.equal(JSON.stringify(__keys().sort()), before, 'Redis не менялся');
  const again = io(); again.saved['s.txt'] = 'есть';
  assert.equal(await X.main(['--out=s.txt'], again), 1);
  assert.match(again.out.join('\n'), /уже есть/);
});

test('main: --help, неверный аргумент, нет Redis, префикс', async () => {
  assert.equal(await X.main(['--help'], io()), 0);
  const bad = io();
  assert.equal(await X.main(['--apply'], bad), 1);
  const url = process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_URL;
  assert.equal(await X.main([], io()), 1);
  process.env.KV_REST_API_URL = url;
  process.env.DB_PREFIX = 't:';
  await bot.mutateBot('p1', (s) => { s.alias['zzqx магазин'] = A('Супермаркеты', 'Zzqx'); });
  process.env.DB_PREFIX = '';
  const empty = io();
  await X.main([], empty);
  assert.match(empty.out.join('\n'), /Префикс базы пуст/);
  assert.match(empty.out.join('\n'), /аккаунтов с псевдонимами 0/);
  process.env.DB_PREFIX = 't:';
  const t = io();
  await X.main([], t);
  assert.match(t.out.join('\n'), /Префикс базы: t:/);
  assert.match(t.out.join('\n'), /аккаунтов: 1/);
});
