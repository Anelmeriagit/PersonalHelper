// Общее для разовых скриптов в scripts/ (это не функция Vercel, в деплой не попадает: см. .vercelignore).

export const chunks = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };

// Подтверждение вводом слова (по умолчанию DELETE) в окне терминала; без терминала отказ. Подходит как io.confirm.
export async function ttyConfirm(q, word = 'DELETE') {
  if (!process.stdin.isTTY) { console.log('Нет терминала для подтверждения: запустите в обычном окне PowerShell или добавьте --yes.'); return false; }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim() === word; } finally { rl.close(); }
}
