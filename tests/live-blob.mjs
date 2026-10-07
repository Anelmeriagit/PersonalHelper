// Проверка НАСТОЯЩЕГО Vercel Blob и Redis для резервных копий (этап 4.2): запись, чтение, список, удаление приватных файлов, ход, ротация, восстановление.
// Заглушки Blob и Redis API Blob по-настоящему не проверяют, поэтому этот прогон нужен один раз после подключения Blob.
// Запуск (PowerShell, из корня; нужен пакет: npm i --no-save @vercel/blob):
//   $env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; $env:BLOB_READ_WRITE_TOKEN='...'; node tests/live-blob.mjs
// Работает только в своих местах: ключи Redis с префиксом selftest<время>: и папка Blob backup-selftest-<время>/ (настоящие копии не трогаются и не вытесняются).
// BACKUP_KEY создаётся случайный и нигде не печатается. В конце всё созданное удаляется. Значения переменных нигде не печатаются.
// Без настоящих баз (проверка логики этого файла): node --import ./tests/register.mjs tests/live-blob.mjs
const { randomBytes } = await import('node:crypto');
const stamp = Date.now();
process.env.DB_PREFIX = 'selftest' + stamp;
process.env.BACKUP_KEY = randomBytes(32).toString('hex');
process.env.BACKUP_DIR = 'backup-selftest-' + stamp;
const db = await import('../api/_db.js');
const B = await import('../api/_backup.js');
let bad = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };
const pause = () => new Promise((r) => setTimeout(r, 1100)); // номер копии содержит время с точностью до секунды: между копиями нужна пауза
const hex = (n) => n.toString(16).padStart(32, '0');
try {
  for (let i = 1; i <= 30; i++) { await db.cmd('HSET', db.key('doc', hex(i)), 'd', JSON.stringify({ n: i, t: 'Ёж "и" \\ ' + 'x'.repeat(200) }), 'v', String(i)); await db.cmd('SET', db.key('nick', 'user' + i), hex(i)); }
  await db.cmd('SADD', db.key('tgs'), hex(1), hex(2));
  await db.cmd('SET', db.key('tgt', 'abc'), hex(1), 'EX', 600); // временный вид: в копию не попадает
  await db.cmd('SET', db.key('misc', 'ttl'), hex(1), 'EX', 600); // неизвестный вид: читается через TYPE и PTTL, срок жизни сохраняется
  const expectKeys = 62; // 30 doc + 30 nick + tgs + misc

  const r1 = await B.runBackup({ partBytes: 3000, count: 10 });
  ok(r1.state === 'done' && r1.keys === expectKeys && r1.parts > 1, 'копия сделана: ' + r1.parts + ' частей, ' + r1.keys + ' ключей из ' + expectKeys);
  const v1 = await B.verifyBackup(r1.snap);
  ok(v1.ok && v1.keys === expectKeys, 'проверка копии: все части читаются из настоящего Blob, sha и шифр сходятся' + (v1.problems.length ? ' (' + v1.problems.join('; ') + ')' : ''));
  const l1 = await B.listBackups();
  ok(l1.length === 1 && l1[0].complete && l1[0].keys === expectKeys, 'список копий (list): одна полная');
  await pause();
  const again = await B.runBackup({ partBytes: 3000, count: 10 });
  ok(again.state === 'done' && again.pruned === 0, 'вторая копия подряд: ход прошлой убран, замок не мешает');
  await pause();
  const r3 = await B.runBackup({ keep: 1, partBytes: 3000, count: 10 });
  const l3 = await B.listBackups();
  ok(r3.pruned === 2 && l3.length === 1 && l3[0].snap === r3.snap, 'ротация: при keep=1 остались только новейшая, старые файлы удалены (del)');
  const man = await B.readManifest(r3.snap);
  const rpx = db.prefix() + 'rst';
  for (const info of man.parts) for (const rec of (await B.readPart(r3.snap, man, info.n)).recs) await db.pipe(B.restoreCmds(rec, rpx));
  const kr = (...a) => rpx + ':' + a.join(':');
  const d7 = await db.getDoc(kr('doc', hex(7)));
  ok(d7.doc && d7.doc.n === 7 && d7.v === 7, 'восстановление из Blob: документ совпадает (версия и содержимое)');
  ok((await db.cmd('SMEMBERS', kr('tgs'))).length === 2 && (await db.cmd('PTTL', kr('misc', 'ttl'))) > 0, 'восстановлены множество и срок жизни');
  ok(Number(await db.cmd('EXISTS', kr('tgt', 'abc'))) === 0, 'временный ключ tgt в копию не попал');
} catch (e) { console.log('FAIL исключение:', e.name, e.message); bad++; }
finally {
  try { // всё созданное удалить: Redis по префиксу, Blob по папке
    let c = '0';
    do { const r = await db.cmd('SCAN', c, 'MATCH', B.globEsc(db.prefix()) + '*', 'COUNT', 200); c = String(r[0]); if (r[1].length) await db.cmd('DEL', ...r[1]); } while (c !== '0');
    const sdk = await import('@vercel/blob');
    for (let page = 0; page < 20; page++) {
      const l = await sdk.list({ prefix: process.env.BACKUP_DIR + '/', limit: 1000 });
      if (l.blobs.length) await sdk.del(l.blobs.map((b) => b.url || b.pathname));
      if (!l.hasMore) break;
    }
    const left = await sdk.list({ prefix: process.env.BACKUP_DIR + '/' });
    console.log(left.blobs.length ? 'ВНИМАНИЕ: в Blob остались файлы папки ' + process.env.BACKUP_DIR + ' (' + left.blobs.length + '), удалите вручную' : 'уборка: тестовые файлы Blob и ключи Redis удалены');
  } catch (e) { console.log('Не удалось убрать за собой (' + (e && e.name) + '): удалите вручную папку ' + process.env.BACKUP_DIR + ' и ключи selftest' + stamp + ':*'); }
}
console.log(bad ? `\nПровалено: ${bad}` : '\nВсе проверки настоящего Blob пройдены');
process.exit(bad ? 1 : 0);
