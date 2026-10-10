// На деплой должны попадать только файлы сайта: всё, что лежит в проекте и не входит в список ниже, обязано быть исключено в .vercelignore.
// Тест падает, если рядом с сайтом появился лишний файл (архив, патч, выгрузка, новый служебный файл) и его не исключили.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Файлы и папки сайта (в корне). Новый файл сайта дописать сюда.
const SITE_FILES = new Set(['index.html', 'style.css', 'theme.js', 'sw.js', 'manifest.webmanifest', 'vercel.json', 'package.json', 'package-lock.json', '.gitignore', '.vercelignore']);
const SITE_DIRS = new Set(['api', 'js', 'Icons', 'logos']);
// Папки, которые никогда не просматриваем (не часть проекта).
const SKIP = new Set(['.git', 'node_modules']);

function ignoreRules() {
  const rules = [];
  for (const raw of fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    assert.ok(!/[*?![\]]/.test(line), 'в .vercelignore только простые строки (имя файла или папка с /), а тут: ' + line);
    rules.push(line);
  }
  return rules;
}
const isIgnored = (rel, rules) => rules.some((r) => (r.endsWith('/') ? rel.startsWith(r) : rel === r));

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) && !rel) continue;
    const r = rel + e.name + (e.isDirectory() ? '/' : '');
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out); else out.push(r);
  }
  return out;
}

test('на деплой попадают только файлы сайта', () => {
  const rules = ignoreRules();
  const stray = walk(ROOT, '', []).filter((rel) => {
    if (isIgnored(rel, rules)) return false;
    const top = rel.split('/')[0];
    return rel.includes('/') ? !SITE_DIRS.has(top) : !SITE_FILES.has(rel);
  });
  assert.deepEqual(stray, [], 'лишние файлы на деплое (удалить, добавить в .vercelignore или в список сайта в этом тесте): ' + stray.join(', '));
});

test('заметки, тесты и скрипты исключены из деплоя', () => {
  const rules = ignoreRules();
  for (const must of ['PROJECT_NOTES.md', 'notes/', 'tests/', 'scripts/', 'node_modules/']) assert.ok(rules.includes(must), '.vercelignore должен содержать ' + must);
});

test('.gitignore закрывает архивы, патчи, логи и временные файлы', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  for (const must of ['.env', 'node_modules/', '*.zip', '*.patch', '*.log', 'tree.txt']) assert.ok(lines.includes(must), '.gitignore должен содержать ' + must);
});

test('vercel.json: на Hobby один ежедневный вызов cron (страховка и перестройка индекса), частые запуски идут снаружи', () => {
  const crons = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).crons;
  assert.equal(crons.length, 1, 'Hobby: cron раз в сутки, лишние записи не нужны');
  const u = new URL(crons[0].path, 'https://x.invalid');
  assert.equal(u.pathname, '/api/cron');
  assert.equal(u.searchParams.get('role'), 'backup', 'ежедневный вызов запасной: при живом основном он ничего не шлёт');
  assert.equal(u.searchParams.get('rebuild'), '1', 'суточная перестройка индекса dueq');
  assert.equal(u.searchParams.get('slot'), null);
  assert.match(crons[0].schedule, /^\d+ \d+ \* \* \*$/, 'раз в сутки: минута и час заданы, остальное звёздочки');
});
