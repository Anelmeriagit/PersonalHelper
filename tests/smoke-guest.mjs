// Сценарий smoke.mjs --only=guest (общие настройки и заглушки: smoke-lib.mjs, fixtures.mjs).
import { makeQr } from '../api/_qr.js';
import { qr } from './fixtures.mjs';
import { SCHEMES, VIEWPORTS, SETUP } from './smoke-lib.mjs';

// ---------- гость: сайт открывается без входа, данные кэшбэка лежат в браузере, на сервер ничего не уходит ----------

export async function guest({ stand, browser, fail }) {
  for (const scheme of SCHEMES) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
      await ctx.addInitScript(SETUP, scheme);
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) problems.push('console: ' + m.text()); });
      // без сессии сервер отвечает 401: это и есть гость; до сервера запрос не доходит, поэтому всё, что дошло до стенда, лишнее
      await page.route('**/api/data', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"auth"}' }));
      const calls0 = stand.apiCalls.length, unm0 = stand.unmocked.length;
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const text = (sel) => page.locator(sel).first().innerText();
      const vis = (sel) => page.locator(sel).first().isVisible();
      const noHScroll = async (where) => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
      };
      try {
        await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector('#mainNav', { state: 'visible', timeout: 5000 });
        check((await page.locator('#lf, #u, #pw').count()) === 0, 'гость: формы входа нет');
        check((await vis('#gBtn')) && !(await vis('#uWrap')), 'гость: в шапке кнопка Google, меню пользователя скрыто');
        check((await vis('#editBtn')) && (await vis('#themeBtn')), 'гость: кнопки правки и темы видны');
        check(await vis('#stage'), 'гость: страница кэшбэка открыта без входа');
        check((await page.locator('#bCur [data-act=add]').count()) === 1, 'гость: пустой месяц, есть «+ Добавить»');
        await noHScroll('гость: главная');

        // запись кэшбэка: сохраняется в браузере (localStorage), на сервер не уходит
        await page.click('#bCur [data-act=add]');
        await page.selectOption('#bCur select[data-k=bank]', 'otp');
        await page.selectOption('#bCur select[data-k=cat]', 'АЗС');
        await page.selectOption('#bCur select[data-k=pct]', '5');
        await page.click('[data-act=save]');
        await page.waitForFunction(() => /АЗС/.test(localStorage.getItem('g-cb') || ''), null, { timeout: 5000 });
        check((await page.locator('#bCur .blk').count()) === 1, 'гость: после сохранения виден один блок');
        await page.waitForFunction(() => document.getElementById('st').textContent === '✓', null, { timeout: 5000 });
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#bCur .blk', { timeout: 5000 });
        check(/АЗС/.test(await text('#bCur')) && /5%/.test(await text('#bCur')), 'гость: запись на месте после перезагрузки');

        // разделы, которым нужен аккаунт: предложение войти вместо содержимого
        await page.goto(stand.url + '/#reminders', { waitUntil: 'load' });
        await page.waitForSelector('#remGuest', { state: 'visible', timeout: 5000 });
        check(!(await vis('#remAcct')) && !(await vis('#tgBox')), 'напоминания гостя: блоки аккаунта скрыты');
        check((await page.locator('#remGuest .gbtn').count()) === 1 && (await page.getAttribute('#remGuest .gbtn', 'href')) === '/api/auth?action=google', 'напоминания гостя: кнопка Google ведёт на вход');
        check((await page.locator('#remGuest .gbtn').evaluate((el) => el.getBoundingClientRect().height)) >= 40, 'напоминания гостя: кнопка слишком мелкая');
        await noHScroll('напоминания гостя');

        // WiFi гостя: форма вместо предложения войти, сеть сохраняется в браузере, QR строит сайт, пароль на сервер не уходит
        await page.goto(stand.url + '/#wifi', { waitUntil: 'load' });
        await page.waitForSelector('#wForm', { state: 'visible', timeout: 5000 });
        check((await page.locator('#wifiGuest').count()) === 0, 'WiFi гостя: предложения войти нет');
        check(/в этом браузере/.test(await text('#wForm .wfn')), 'WiFi гостя: в форме сказано, что данные только в браузере');
        await noHScroll('WiFi гостя: форма');
        await page.fill('#wfSsid', 'GuestNet');
        await page.fill('#wfPw', 'guest-pass-1');
        await page.click('#wForm .done');
        await page.waitForSelector('.wqr svg.qr', { state: 'visible', timeout: 5000 });
        const wq = makeQr('WIFI:T:WPA;S:GuestNet;P:guest-pass-1;H:false;;');
        const wsvg = await page.evaluate(() => { const s = document.querySelector('.wqr svg.qr'); return { vb: s.getAttribute('viewBox'), d: s.querySelector('path').getAttribute('d') }; });
        check(wsvg.vb === `0 0 ${wq.size + 8} ${wq.size + 8}`, 'WiFi гостя: размер QR как у серверного: ' + wsvg.vb);
        const darkWant = wq.rows.join('').split('1').length - 1;
        check([...wsvg.d.matchAll(/h(\d+)v1/g)].reduce((n, m) => n + Number(m[1]), 0) === darkWant, 'WiFi гостя: тёмные модули QR как у серверного');
        check(/GuestNet/.test(await text('.wi')) && !/guest-pass-1/.test(await text('.wi')), 'WiFi гостя: название видно, пароль скрыт');
        const wl = await page.evaluate(() => localStorage.getItem('g-wf') || '');
        check(/GuestNet/.test(wl) && /guest-pass-1/.test(wl) && !/qr/.test(wl), 'WiFi гостя: сеть в браузере, без QR');
        await noHScroll('WiFi гостя: сеть');
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('.wqr svg.qr', { state: 'visible', timeout: 5000 });
        check(/GuestNet/.test(await text('.wi')), 'WiFi гостя: сеть на месте после перезагрузки');

        // агент гостя: четыре строки по умолчанию, время сохраняется в браузере, подпись «через …»
        await page.goto(stand.url + '/#agent', { waitUntil: 'load' });
        await page.waitForSelector('#agBody .agr', { state: 'visible', timeout: 5000 });
        check((await page.locator('#agentGuest').count()) === 0, 'агент гостя: предложения войти нет');
        check((await page.locator('#agBody .agr').count()) === 4, 'агент гостя: четыре строки по умолчанию');
        await noHScroll('агент гостя: список');
        const row0 = page.locator('#agBody .agr').first();
        await row0.locator('select[data-k=h]').selectOption('9');
        await row0.locator('select[data-k=m]').selectOption('30');
        await page.waitForFunction(() => /"h":9/.test(localStorage.getItem('g-ag') || '') && /"m":30/.test(localStorage.getItem('g-ag') || ''), null, { timeout: 7000 });
        const ag = await page.evaluate(() => JSON.parse(localStorage.getItem('g-ag')).rows);
        check(ag.length === 4 && ag[0].at > Date.now() && ag[1].at === null, 'агент гостя: момент сброса посчитан только у строки со временем');
        check(/через/.test(await row0.locator('.ags').innerText()), 'агент гостя: подпись «через …»');
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#agBody .agr', { state: 'visible', timeout: 5000 });
        check((await page.locator('#agBody .agr').first().locator('select[data-k=h]').inputValue()) === '9', 'агент гостя: время на месте после перезагрузки');
        await noHScroll('агент гостя: со временем');
        await page.goto(stand.url + '/', { waitUntil: 'load' });
        await page.waitForSelector('#mainNav', { state: 'visible', timeout: 5000 });
        check(!(await vis('#remAcct')) && (await page.locator('#remGuest').isHidden()), 'на главной предложение войти не показано');

        check(stand.apiCalls.length === calls0, 'гость: на сервер ушли запросы: ' + stand.apiCalls.slice(calls0).join(', '));
        check(stand.unmocked.length === unm0, 'нет заглушки API: ' + stand.unmocked.slice(unm0).join(', '));
        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  гостевой режим${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
