// Сценарий smoke.mjs --only=session (общие настройки и заглушки: smoke-lib.mjs, fixtures.mjs).
import { qr, ACC_ID } from './fixtures.mjs';
import { SCHEMES, VIEWPORTS, SETUP } from './smoke-lib.mjs';

// ---------- из аккаунта в гостя: конец сессии (401) и выход; данные аккаунта заменяют гостевые ----------

export async function session({ stand, browser, fail }) {
  for (const scheme of SCHEMES) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
      await ctx.addInitScript(SETUP, scheme);
      await ctx.addInitScript((id) => { try { localStorage.setItem('g-mg', JSON.stringify([id])); } catch { /* нет доступа */ } }, ACC_ID); // слияние отдельный сценарий (merge): здесь аккаунт уже отмечен
      const page = await ctx.newPage();
      const problems = [];
      const posts = [];
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) problems.push('console: ' + m.text()); });
      await page.route('**/api/auth', (r) => { posts.push(r.request().postDataJSON()); r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const vis = (sel) => page.locator(sel).first().isVisible();
      const local = () => page.evaluate(() => localStorage.getItem('g-cb') || '');
      try {
        // 1. в браузере уже есть гостевые данные (до входа)
        await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
        await page.evaluate(() => localStorage.setItem('g-cb', JSON.stringify({ months: {}, custom: ['Моя гостевая'], rev: {} })));
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 });
        check(!(await vis('#gBtn')), 'аккаунт: кнопки Google в шапке нет');

        // 2. сессия заканчивается во время правки: несохранённое остаётся, но уже в гостевых данных
        await page.route('**/api/data', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"auth"}' }) : r.fallback()));
        await page.click('#editBtn');
        await page.click('[data-act=addb]');
        await page.selectOption('#bCur .blk:last-of-type select[data-k=bank]', 'vtb');
        await page.selectOption('#bCur .blk:last-of-type select[data-k=cat]', 'Аптеки');
        await page.selectOption('#bCur .blk:last-of-type select[data-k=pct]', '3');
        await page.click('[data-act=save]');
        await page.waitForSelector('#gBtn', { state: 'visible', timeout: 6000 });
        check(!(await vis('#uWrap')) && (await vis('#mainNav')), '401: гость, навигация осталась');
        check((await page.locator('#lf').count()) === 0, '401: экрана входа нет');
        check(/гостевом режиме/.test(await page.locator('#warn').innerText()), '401: объяснение про гостевой режим');
        check((await page.locator('#bCur .blk').count()) === 4, '401: на странице данные аккаунта с правкой (4 банка)');
        const l1 = await local();
        check(/Аптеки/.test(l1) && /vtb/.test(l1) && /Маркетплейсы/.test(l1), '401: правка и данные аккаунта в гостевом хранилище');
        check(!/Моя гостевая/.test(l1), '401: прежние гостевые данные заменены');
        check(await vis('#editBtn'), '401: кнопка правки доступна гостю');
        await page.goto('about:blank');
        await page.goto(stand.url + '/', { waitUntil: 'load' });
        await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 }); // стенд снова отвечает как аккаунт

        // 2b. сессия заканчивается на странице «Агент»: строки (с правкой) и сеть аккаунта заменяют гостевые
        await page.evaluate(() => {
          localStorage.setItem('g-wf', JSON.stringify({ ssid: 'GuestNet', password: 'guest-pass-1', security: 'WPA', hidden: false }));
          localStorage.setItem('g-ag', JSON.stringify({ rows: [{ id: 'gg', app: 'Моя гостевая', h: null, m: null, at: null }] }));
          location.hash = '#wifi';
        });
        await page.waitForSelector('.wqr svg.qr', { state: 'visible', timeout: 5000 }); // сеть аккаунта загружена в память
        await page.evaluate(() => { location.hash = '#agent'; });
        await page.waitForSelector('#agBody .agr', { state: 'visible', timeout: 5000 });
        await page.route('**/api/agent', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"auth"}' }) : r.fallback()));
        await page.locator('#agBody .agr').first().locator('select[data-k=h]').selectOption('7');
        await page.locator('#agBody .agr').first().locator('select[data-k=m]').selectOption('20');
        await page.waitForSelector('#gBtn', { state: 'visible', timeout: 8000 });
        const l3 = await page.evaluate(() => ({ ag: localStorage.getItem('g-ag') || '', wf: localStorage.getItem('g-wf') || '' }));
        check(/"id":"a1"/.test(l3.ag) && /"h":7/.test(l3.ag) && /"m":20/.test(l3.ag) && !/Моя гостевая/.test(l3.ag), '401 на «Агенте»: строки аккаунта с правкой заменили гостевые');
        check(/TestNet/.test(l3.wf) && /test-password/.test(l3.wf) && !/GuestNet/.test(l3.wf), '401 на «Агенте»: сеть аккаунта заменила гостевую');
        check((await page.locator('#agBody .agr').count()) === 4 && (await page.locator('#agBody .agr').first().locator('select[data-k=h]').inputValue()) === '7', '401 на «Агенте»: на странице те же строки с правкой');
        check(/гостевом режиме/.test(await page.locator('#warn').innerText()), '401 на «Агенте»: объяснение про гостевой режим');
        await page.goto('about:blank');
        await page.unroute('**/api/agent');
        await page.goto(stand.url + '/', { waitUntil: 'load' });
        await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 });

        // 3. выход: свежие данные аккаунта заменяют гостевые
        await page.unroute('**/api/data');
        await page.evaluate(() => {
          localStorage.setItem('g-cb', JSON.stringify({ months: {}, custom: ['Ещё гостевая'], rev: {} }));
          localStorage.setItem('g-wf', JSON.stringify({ ssid: 'GuestNet', password: 'guest-pass-1', security: 'WPA', hidden: false }));
          localStorage.setItem('g-ag', JSON.stringify({ rows: [{ id: 'gg', app: 'Моя гостевая', h: null, m: null, at: null }] }));
        });
        await page.goto('about:blank');
        await page.goto(stand.url + '/', { waitUntil: 'load' });
        await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 });
        await page.click('#uBtn'); await page.click('#uMenu [data-u=logout]');
        await page.waitForSelector('#gBtn', { state: 'visible', timeout: 5000 });
        check(posts.filter((x) => x.action === 'logout').length === 1, 'выход: запрос logout');
        const l2 = await local();
        check(/Маркетплейсы/.test(l2) && !/Ещё гостевая/.test(l2), 'выход: данные аккаунта заменили гостевые: ' + l2.slice(0, 80));
        check((await page.locator('#bCur .blk').count()) === 3 && (await vis('#mainNav')), 'выход: на странице данные аккаунта, навигация на месте');
        const l4 = await page.evaluate(() => ({ ag: localStorage.getItem('g-ag') || '', wf: localStorage.getItem('g-wf') || '' }));
        check(/"id":"a1"/.test(l4.ag) && !/Моя гостевая/.test(l4.ag), 'выход: строки агента аккаунта заменили гостевые');
        check(/TestNet/.test(l4.wf) && !/GuestNet/.test(l4.wf), 'выход: сеть аккаунта заменила гостевую');
        check((await page.locator('#lf').count()) === 0, 'выход: экрана входа нет');
        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  из аккаунта в гостя${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
