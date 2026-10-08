// Общее для разовых скриптов в scripts/ (это не функция Vercel, в деплой не попадает: см. .vercelignore).
import { cmd } from '../api/_db.js';

export const CHUNK = 100;
export const short = (id) => String(id).slice(0, 8);
export const globEsc = (s) => s.replace(/[\\*?[\]]/g, '\\$&'); // спецсимволы шаблона SCAN в префиксе
export const chunks = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };

// Все ключи по шаблону: SCAN по курсору до конца (Redis может вернуть повторы, поэтому Set).
export async function scan(pattern) {
  const found = new Set();
  let cur = '0';
  do {
    const r = await cmd('SCAN', cur, 'MATCH', pattern, 'COUNT', 500);
    cur = String(r[0]);
    for (const k of r[1] || []) found.add(k);
  } while (cur !== '0');
  return [...found];
}

// Подтверждение вводом слова (по умолчанию DELETE) в окне терминала; без терминала отказ. Подходит как io.confirm.
export async function ttyConfirm(q, word = 'DELETE') {
  if (!process.stdin.isTTY) { console.log('Нет терминала для подтверждения: запустите в обычном окне PowerShell или добавьте --yes.'); return false; }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim() === word; } finally { rl.close(); }
}
