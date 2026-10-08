// Сценарий smoke.mjs --only=merge (общие настройки и заглушки: smoke-lib.mjs, fixtures.mjs).
import { qr, mskDay, ACC_ID } from './fixtures.mjs';
import { SCHEMES, VIEWPORTS, SETUP } from './smoke-lib.mjs';

// ---------- слияние гостевых данных при входе в аккаунт ----------

export async function merge({ stand, browser, fail }) {
  for (const scheme of SCHEMES) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
      await ctx.addInitScript(SETUP, scheme);
      const cur = mskDay(0).slice(0, 7);
      // гостевые данные кладутся один раз (флаг seeded), чтобы перезагрузка не возвращала их после слияния
      await ctx.addInitScript((m) => {
        try {
          if (localStorage.getItem('seeded')) return;
          localStorage.setItem('seeded', '1');
          localStorage.setItem('g-cb', JSON.stringify({ months: { [m]: [{ bank: 'vtb', items: [{ cat: 'Аптеки', pct: '3' }] }, { bank: 'otp', items: [{ cat: 'АЗС', pct: '10' }] }] }, custom: ['Моя гостевая'], rev: {} }));
          localStorage.setItem('g-ag', JSON.stringify({ rows: [{ id: 'g1', app: 'app', h: 7, m: 20, at: null }, { id: 'g2', app: 'Chrome', h: 9, m: 10, at: null }] }));
          localStorage.setItem('g-wf', JSON.stringify({ ssid: 'GuestNet', password: 'guest-pass-1', security: 'WPA', hidden: false }));
        } catch { /* нет доступа */ }
      }, cur);
      const page = await ctx.newPage();
      const problems = [];
      const sent = { data: [], agent: [], wifi: [] };
      let dataStatus = 200;
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|500)/.test(m.text())) problems.push('console: ' + m.text()); });
      const json = (r, status, obj) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
      // у аккаунта нет сети WiFi: слияние переносит гостевую
      await page.route('**/api/wifi', (r) => {
        const q = r.request();
        if (q.method() === 'PUT') { const b = q.postDataJSON(); sent.wifi.push(b); return json(r, 200, { configured: true, ssid: b.ssid, password: b.password, security: b.security, hidden: b.hidden, qr: qr }); }
        return json(r, 200, { configured: false });
      });
      await page.route('**/api/agent', (r) => {
        const q = r.request();
        if (q.method() === 'PUT') { const b = q.postDataJSON(); sent.agent.push(b); return json(r, 200, { rows: b.rows }); }
        return r.fallback();
      });
      await page.route('**/api/data', (r) => {
        const q = r.request();
        if (q.method() === 'PUT') {
          const b = q.postDataJSON(); sent.data.push(b);
          if (dataStatus !== 200) return json(r, dataStatus, { error: 'x' });
          return json(r, 200, { ok: true, rev: Object.fromEntries(Object.keys(b.parts).map((k) => [k, b.parts[k].base + 1])) });
        }
        return r.fallback();
      });
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const vis = (sel) => page.locator(sel).first().isVisible();
      const ls = (k) => page.evaluate((key) => localStorage.getItem(key) || '', k);
      const noHScroll = async (where) => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
      };
      try {
        // 1. первый вход в аккаунт с гостевыми данными: всё сливается, на экране итог и короткое сообщение
        await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 });
        await page.waitForSelector('#bCur .blk', { timeout: 5000 });
        check(sent.data.length === 1 && sent.agent.length === 1 && sent.wifi.length === 1, `слияние: по одной записи кэшбэка, агента и WiFi, а было ${sent.data.length}/${sent.agent.length}/${sent.wifi.length}`);
        const d = sent.data[0] || { parts: {} };
        check(JSON.stringify(Object.keys(d.parts).sort()) === JSON.stringify(['custom', cur].sort()), 'слияние кэшбэка: изменены месяц и свои категории: ' + Object.keys(d.parts).join(','));
        check(d.parts[cur] && d.parts[cur].base === 0 && d.parts[cur].value.map((b) => b.bank).join() === 'otp,alfa,sber,vtb', 'слияние кэшбэка: банки аккаунта первыми, затем недостающий банк гостя: ' + JSON.stringify(d.parts[cur] && d.parts[cur].value.map((b) => b.bank)));
        check(d.parts[cur] && d.parts[cur].value[0].items.map((i) => i.pct).join() === '12,5', 'слияние кэшбэка: при конфликте банка остаётся запись аккаунта (12 и 5, не гостевые 10)');
        check(d.parts.custom && d.parts.custom.value.join() === 'Моя гостевая', 'слияние кэшбэка: своя категория гостя объединена');
        check((await page.locator('#bCur .blk').count()) === 4, 'слияние: на странице четыре банка (три аккаунта и один гостя)');
        check(/гостевого режима/.test(await page.locator('#warn').innerText()), 'слияние: сообщение о добавленных данных');
        const ag = sent.agent[0] ? sent.agent[0].rows : [];
        check(ag.length === 5 && ag[0].app === 'app' && ag[0].h === 7 && ag[0].m === 20 && ag[4].app === 'Chrome' && ag[4].h === 9, 'слияние агента: время гостя у пустой строки, лишняя строка в конце: ' + JSON.stringify(ag.map((r) => [r.app, r.h, r.m])));
        check(sent.wifi[0] && sent.wifi[0].ssid === 'GuestNet' && sent.wifi[0].password === 'guest-pass-1', 'слияние WiFi: сеть гостя перенесена');
        check((await ls('g-mg')).indexOf(ACC_ID) > -1, 'слияние: аккаунт отмечен в браузере');
        await noHScroll('слияние: главная');

        // 2. тот же аккаунт ещё раз: слияния нет (метка), записей и сообщения нет
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 });
        await page.waitForSelector('#bCur .blk', { timeout: 5000 });
        check(sent.data.length === 1 && sent.agent.length === 1 && sent.wifi.length === 1, 'повторный вход: слияния нет');
        check(!/гостевого режима/.test(await page.locator('#warn').innerText()), 'повторный вход: сообщения нет');

        // 3. отказ сервера: метки нет, сайт открывается с данными аккаунта, гостевые данные на месте; после восстановления слияние проходит
        await page.evaluate(() => { localStorage.removeItem('g-mg'); });
        dataStatus = 500;
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 });
        await page.waitForSelector('#bCur .blk', { timeout: 5000 });
        check(sent.data.length === 2, 'отказ: запись кэшбэка пробовалась');
        check((await page.locator('#bCur .blk').count()) === 3, 'отказ: на странице данные аккаунта без слияния');
        check(!(await ls('g-mg')) || (await ls('g-mg')).indexOf(ACC_ID) < 0, 'отказ: метки нет');
        check(/Моя гостевая/.test(await ls('g-cb')), 'отказ: гостевые данные на месте');
        dataStatus = 200;
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#bCur .blk', { timeout: 5000 });
        check(sent.data.length === 3 && (await page.locator('#bCur .blk').count()) === 4 && (await ls('g-mg')).indexOf(ACC_ID) > -1, 'повтор после отказа: слияние прошло, метка стоит');
        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  слияние при входе${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
