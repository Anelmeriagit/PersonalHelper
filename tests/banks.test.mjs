// Справочник банков: сервер (api/_lib.js), сайт (js/cashback/state.js), названия в боте (api/_bot.js) и файлы logos/ совпадают.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BANKS } from '../api/_lib.js';
import { BANKS as SITE } from '../js/cashback/state.js';

const botNames = () => {
  const src = fs.readFileSync(new URL('../api/_bot.js', import.meta.url), 'utf8');
  const m = src.match(/const BANK_NAMES = \{([\s\S]*?)\};/);
  assert.ok(m, 'BANK_NAMES не найден в api/_bot.js');
  const out = {};
  for (const [, k, v] of m[1].matchAll(/(\w+):\s*'([^']*)'/g)) out[k] = v;
  return out;
};

test('банки: id на сервере и на сайте одинаковы и в том же порядке', () => {
  assert.deepEqual(Object.keys(SITE), BANKS);
  assert.equal(new Set(BANKS).size, BANKS.length);
});

test('банки: у каждого есть название, значок-буква и файл логотипа', () => {
  for (const id of BANKS) {
    assert.ok(SITE[id].n && SITE[id].m, id + ': нет n или m');
    const f = new URL('../logos/' + id + '.svg', import.meta.url);
    assert.ok(fs.existsSync(f), id + ': нет logos/' + id + '.svg');
    const svg = fs.readFileSync(f, 'utf8');
    assert.match(svg, /^<svg[^>]*viewBox=/, id + ': не SVG с viewBox');
    assert.doesNotMatch(svg, /<script|\son\w+=|href=/i, id + ': в логотипе скрипт или ссылка');
  }
});

test('банки: названия в боте совпадают с сайтом', () => {
  const names = botNames();
  assert.deepEqual(Object.keys(names), BANKS);
  for (const id of BANKS) assert.equal(names[id], SITE[id].n, id);
});
