// Сценарий smoke.mjs --only=refresh (общие настройки и заглушки: smoke-lib.mjs, fixtures.mjs).
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';

// ---------- меньше команд Redis: возврат на вкладку не чаще раза в 5 минут, привязка без лишних запросов, опрос с растущими паузами, пауза сохранения ----------
// Время подменяется (page.clock): 5 минут и 10 минут проходят за секунды. Видимость вкладки подменяется вручную (document.visibilityState + событие).
const MIN5 = 5 * 60 * 1000;

export async function refresh({ stand, browser, fail }) {
  for (const scheme of SCHEMES) {
    for (const vp of VIEWPORTS) {
      const problems = [];
      const ctxs = [];
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const n = (key, from = 0) => stand.apiCalls.slice(from).filter((k) => k === key).length;
      const settle = (page) => page.waitForTimeout(150);
      const setVis = (page, v) => page.evaluate((x) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => x }); document.dispatchEvent(new Event('visibilitychange')); }, v);
      const back = async (page) => { await setVis(page, 'hidden'); await setVis(page, 'visible'); await settle(page); };
      const openPage = async (iso, hash, setup) => {
        const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
        ctxs.push(ctx);
        await ctx.addInitScript((s) => {
          try { localStorage.setItem('theme', s); localStorage.setItem('welcome', '1'); } catch { /* нет доступа */ }
          window.__csp = [];
          document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
        }, scheme);
        const page = await ctx.newPage();
        page.on('pageerror', (e) => problems.push('JS: ' + e.message));
        page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
        if (setup) await setup(page);
        await page.clock.install({ time: new Date(iso) });
        await page.goto(stand.url + '/' + hash, { waitUntil: 'load', timeout: 15000 });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await settle(page);
        return page;
      };
      const before = stand.unmocked.length;
      try {
        // 1. кэшбэк: возврат на вкладку в течение 5 минут запроса не делает, после 5 минут делает
        {
          const t0 = stand.apiCalls.length;
          const page = await openPage('2026-10-15T09:00:00Z', '');
          await page.waitForSelector('#bCur .col', { timeout: 5000 });
          check(n('GET /api/data', t0) === 1, 'кэшбэк: при входе один GET /api/data, было ' + n('GET /api/data', t0));
          for (let i = 0; i < 3; i++) await back(page);
          check(n('GET /api/data', t0) === 1, 'кэшбэк: три возврата на вкладку за 5 минут не должны читать данные, всего GET /api/data ' + n('GET /api/data', t0));
          await page.clock.fastForward(MIN5 + 1000);
          await back(page);
          check(n('GET /api/data', t0) === 2, 'кэшбэк: через 5 минут возврат на вкладку обновляет данные, всего GET /api/data ' + n('GET /api/data', t0));
          await back(page);
          check(n('GET /api/data', t0) === 2, 'кэшбэк: сразу после обновления повторного чтения нет');
        }

        // 2. смена месяца обновляет сразу, хотя пять минут не прошло
        {
          const t0 = stand.apiCalls.length;
          const page = await openPage('2026-10-31T20:58:00Z', '');
          await page.waitForSelector('#bCur .col', { timeout: 5000 });
          await page.clock.setSystemTime(new Date('2026-10-31T21:01:00Z')); // 00:01 по Москве, 1 ноября
          await back(page);
          check(n('GET /api/data', t0) === 2, 'смена месяца: возврат на вкладку обновляет сразу, всего GET /api/data ' + n('GET /api/data', t0));
        }

        // 3. напоминания, Wi-Fi, агент: вход и переход на раздел грузят всегда, возврат на вкладку не чаще раза в 5 минут; привязка Telegram без отдельного запроса
        {
          const t0 = stand.apiCalls.length;
          const page = await openPage('2026-10-15T09:00:00Z', '#reminders');
          await page.waitForSelector('#tgBody .tgn', { timeout: 5000 });
          check(n('GET /api/reminders', t0) === 1, 'напоминания: при входе один GET /api/reminders, было ' + n('GET /api/reminders', t0));
          check(n('GET /api/tglink', t0) === 0, 'напоминания: при входе на страницу нет GET /api/tglink, было ' + n('GET /api/tglink', t0));
          check(/Telegram привязан/.test(await page.locator('#tgBody .tgn').innerText()), 'блок Telegram показывает «привязан» из ответа напоминаний');
          await back(page); await back(page);
          check(n('GET /api/reminders', t0) === 1 && n('GET /api/tglink', t0) === 0, 'напоминания: возвраты на вкладку за 5 минут запросов не делают');
          await page.clock.fastForward(MIN5 + 1000);
          await back(page);
          check(n('GET /api/reminders', t0) === 2, 'напоминания: через 5 минут возврат обновляет список');
          check(n('GET /api/tglink', t0) === 0, 'напоминания: и при возврате на вкладку нет GET /api/tglink, было ' + n('GET /api/tglink', t0));

          await page.evaluate(() => { location.hash = '#wifi'; }); await settle(page);
          check(n('GET /api/wifi', t0) === 1, 'Wi-Fi: переход на раздел грузит данные');
          await back(page);
          check(n('GET /api/wifi', t0) === 1, 'Wi-Fi: возврат на вкладку за 5 минут запроса не делает');
          await page.clock.fastForward(MIN5 + 1000);
          await back(page);
          check(n('GET /api/wifi', t0) === 2, 'Wi-Fi: через 5 минут возврат обновляет');

          await page.evaluate(() => { location.hash = '#reminders'; }); await settle(page);
          check(n('GET /api/reminders', t0) === 3, 'напоминания: переход на раздел грузит сразу, даже если данные свежие, всего ' + n('GET /api/reminders', t0));

          await page.evaluate(() => { location.hash = '#agent'; }); await settle(page);
          check(n('GET /api/agent', t0) === 1, 'агент: переход на раздел грузит строки один раз, было ' + n('GET /api/agent', t0));
          await back(page);
          check(n('GET /api/agent', t0) === 1, 'агент: возврат на вкладку за 5 минут запроса не делает');
          await page.clock.fastForward(MIN5 + 1000);
          await back(page);
          check(n('GET /api/agent', t0) === 2, 'агент: через 5 минут возврат обновляет строки');
        }

        // 4. опрос привязки: паузы растут (4 → 8 → 15 с), скрытая вкладка не опрашивается, при возврате одна проверка, через 10 минут стоп
        {
          const page = await openPage('2026-10-15T09:00:00Z', '#reminders', async (p) => {
            await p.route('**/api/reminders', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ linked: false, custom: [], recurring: [] }) }));
          });
          await page.waitForSelector('#tgBody [data-t=link]', { timeout: 5000 });
          await page.click('#tgBody [data-t=link]');
          await page.waitForSelector('#tgBody a.btn', { timeout: 5000 });
          const t1 = stand.apiCalls.length;
          const polls = () => n('GET /api/tglink', t1);
          const step = async (ms) => { await page.clock.runFor(ms); await page.waitForTimeout(12); };
          let el = 0;
          for (; el < 20000; el += 2000) await step(2000);
          check(polls() >= 4 && polls() <= 6, 'опрос: в первые 20 с от 4 до 6 запросов (шаг 4 с), было ' + polls());
          await setVis(page, 'hidden'); await settle(page); // запрос, уже отправленный в момент скрытия, должен успеть дойти до стенда
          const h0 = polls();
          for (let i = 0; i < 30; i++, el += 2000) await step(2000);
          check(polls() === h0, 'опрос: пока вкладка скрыта, запросов нет, было ' + (polls() - h0));
          await setVis(page, 'visible'); await settle(page);
          check(polls() === h0 + 1, 'опрос: при возврате на вкладку одна проверка сразу, было ' + (polls() - h0));
          let at300 = -1;
          for (; el < 640000; el += 2000) { await step(2000); if (at300 < 0 && el >= 300000) at300 = polls(); }
          const total = polls();
          check(total >= 25 && total <= 60, 'опрос за 10 минут: от 25 до 60 запросов (раньше было 150), было ' + total);
          check(total - at300 <= 22, 'опрос: во вторые 5 минут пауза 15 с, не больше 22 запросов, было ' + (total - at300));
          await page.waitForFunction(() => /Ссылка устарела/.test(document.getElementById('tgMsg').textContent), null, { timeout: 3000 });
          for (let i = 0; i < 30; i++) await step(2000);
          check(polls() === total, 'опрос: после срока ссылки запросов нет, было ' + (polls() - total));
        }

        // 5. сохранение: пауза перед записью 1,8 с; при уходе со вкладки правка уходит сразу
        {
          const t0 = stand.apiCalls.length;
          const page = await openPage('2026-10-15T09:00:00Z', '');
          await page.waitForSelector('#bCur .col', { timeout: 5000 });
          const edit = async () => {
            await page.click('#editBtn');
            const sel = page.locator('#bCur select[data-k=pct]').first();
            const cur = await sel.inputValue();
            const vals = await sel.evaluate((el) => Array.from(el.options).map((o) => o.value));
            await sel.selectOption(vals.filter((v) => v && v !== cur)[0]);
            await page.click('#editBtn');
          };
          await edit();
          await page.clock.runFor(1000); await settle(page);
          check(n('PUT /api/data', t0) === 0, 'кэшбэк: через 1 с после правки записи ещё нет, было ' + n('PUT /api/data', t0));
          await page.clock.runFor(900); await settle(page);
          check(n('PUT /api/data', t0) === 1, 'кэшбэк: через 1,9 с запись ушла, было ' + n('PUT /api/data', t0));
          await edit();
          await setVis(page, 'hidden'); await settle(page);
          check(n('PUT /api/data', t0) === 2, 'кэшбэк: при уходе со вкладки правка сохраняется сразу, не дожидаясь паузы, было ' + n('PUT /api/data', t0));

          await page.evaluate(() => { location.hash = '#agent'; });
          await setVis(page, 'visible');
          await page.waitForSelector('.agr select[data-k=h]', { timeout: 5000 });
          const a0 = stand.apiCalls.length;
          const pick = async (i) => page.locator('.agr select[data-k=h]').first().selectOption({ index: i });
          await pick(3);
          await page.clock.runFor(1000); await settle(page);
          check(n('PUT /api/agent', a0) === 0, 'агент: через 1 с после правки записи ещё нет, было ' + n('PUT /api/agent', a0));
          await page.clock.runFor(900); await settle(page);
          check(n('PUT /api/agent', a0) === 1, 'агент: через 1,9 с запись ушла, было ' + n('PUT /api/agent', a0));
          await pick(5);
          await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await settle(page);
          check(n('PUT /api/agent', a0) === 2, 'агент: при закрытии страницы правка сохраняется сразу, было ' + n('PUT /api/agent', a0));
          const csp = await page.evaluate(() => window.__csp);
          check(!csp.length, 'CSP: ' + csp.join('; '));
        }
        check(stand.unmocked.length === before, 'нет заглушки API: ' + stand.unmocked.slice(before).join(', '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  меньше команд Redis: возврат на вкладку, опрос, сохранение${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      for (const c of ctxs) await c.close();
    }
  }
}
