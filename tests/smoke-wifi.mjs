// Сценарий smoke.mjs --only=wifi (общие настройки и заглушки: smoke-lib.mjs, fixtures.mjs).
import { qr } from './fixtures.mjs';
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';

// ---------- личная сеть Wi-Fi: форма, сохранение, правка, удаление ----------

export async function wifi({ stand, browser, fail }) {
  for (const scheme of SCHEMES) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
      await ctx.addInitScript((s) => {
        try { localStorage.setItem('theme', s); localStorage.setItem('welcome', '1'); } catch { /* нет доступа */ }
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
      }, scheme);
      const page = await ctx.newPage();
      const problems = [];
      const calls = [];
      let net = null;
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of 400/.test(m.text())) problems.push('console: ' + m.text()); });
      await page.route('**/api/wifi', (r) => {
        const req = r.request(), m = req.method();
        let status = 200, body;
        if (m === 'GET') body = net ? { configured: true, ...net, qr } : { configured: false };
        else if (m === 'PUT') {
          const b = req.postDataJSON();
          calls.push(['PUT', b]);
          if (b.security !== 'nopass' && b.password.length < 8) { status = 400; body = { error: 'password' }; }
          else { net = { ssid: b.ssid, password: b.password, security: b.security, hidden: b.hidden }; body = { configured: true, ...net, qr }; }
        } else { calls.push([m]); net = null; body = { configured: false }; }
        r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      });
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const text = (sel) => page.locator(sel).first().innerText();
      const noHScroll = async (where) => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
      };
      try {
        await page.goto(stand.url + '/#wifi', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector('#wForm', { timeout: 5000 });
        check((await page.locator('#wifiBody .wqr').count()) === 0, 'не настроено: QR нет');
        check(/хранятся только в вашем аккаунте/.test(await text('#wifiBody')), 'не настроено: пояснение про аккаунт');
        check((await page.locator('#wifiBody [data-wf=del]').count()) === 0, 'не настроено: кнопки «Удалить» нет');
        await noHScroll('форма пустая');

        await page.click('#wForm .done');
        check((await text('#wfErr')) === 'Введите название сети', 'пустое название: сообщение');
        check(calls.length === 0, 'пустое название: запроса быть не должно');

        await page.selectOption('#wfSec', 'nopass');
        check(!(await page.locator('#wfPwBox').isVisible()), 'без пароля: поле пароля скрыто');
        await page.selectOption('#wfSec', 'WPA');
        check(await page.locator('#wfPwBox').isVisible(), 'WPA: поле пароля видно');
        check((await page.inputValue('#wfPw')) === '' && (await page.getAttribute('#wfPw', 'type')) === 'password', 'пароль скрыт точками');
        await page.check('#wfPwShow');
        check((await page.getAttribute('#wfPw', 'type')) === 'text', 'показать пароль');

        await page.fill('#wfSsid', 'HomeNet'); await page.fill('#wfPw', 'short');
        await page.click('#wForm .done');
        await page.waitForFunction(() => document.getElementById('wfErr').textContent.length > 0, null, { timeout: 5000 });
        check(/WPA/.test(await text('#wfErr')), 'ответ 400: сообщение про пароль WPA «' + (await text('#wfErr')) + '»');
        check(await page.locator('#wForm').isVisible() && !(await page.locator('#wForm .done').isDisabled()), 'после ошибки форма остаётся и кнопка снова доступна');
        await noHScroll('форма с ошибкой');

        await page.fill('#wfPw', 'secret-pass-1'); await page.check('#wfHid');
        await page.press('#wfPw', 'Enter'); // кнопка «Сохранить» под сообщением об ошибке на 360 px не ловит щелчок Playwright (на странице под указателем кнопка), отправляем с клавиатуры
        await page.waitForSelector('#wifiBody .wqr', { timeout: 5000 });
        const put = calls[calls.length - 1][1];
        check(JSON.stringify(put) === JSON.stringify({ ssid: 'HomeNet', security: 'WPA', password: 'secret-pass-1', hidden: true }), 'запрос сохранения: ' + JSON.stringify(put));
        check((await page.locator('#wifiBody .wqr .qr').count()) === 1, 'после сохранения нарисован QR');
        check((await text('#wPw')).includes('•') && !(await text('#wifiBody')).includes('secret-pass-1'), 'пароль на экране скрыт точками');
        check((await page.locator('#wifiBody [data-wf=edit]').count()) === 1, 'есть кнопка «Изменить сеть»');
        await noHScroll('сеть настроена');

        await page.click('[data-wf=edit]');
        check((await page.inputValue('#wfSsid')) === 'HomeNet' && (await page.inputValue('#wfPw')) === 'secret-pass-1' && (await page.isChecked('#wfHid')), 'правка: поля заполнены текущими значениями');
        await page.click('[data-wf=cancel]');
        check((await page.locator('#wifiBody .wqr').count()) === 1 && (await page.locator('#wForm').count()) === 0, 'отмена возвращает экран с QR без запроса');

        await page.click('[data-wf=edit]');
        await page.click('[data-wf=del]');
        await page.waitForSelector('#dlg[open]', { timeout: 3000 });
        await page.click('#dlg .done');
        await page.waitForSelector('#wifiBody [data-wf=del]', { state: 'detached', timeout: 5000 });
        await page.waitForSelector('#wForm', { timeout: 5000 });
        check(calls[calls.length - 1][0] === 'DELETE', 'удаление: был DELETE');
        check((await page.locator('#wifiBody .qr').count()) === 0 && !(await page.locator('#wifiBody').innerHTML()).includes('secret-pass-1'), 'после удаления QR и пароль пропали из страницы');
        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  wifi: личная сеть${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
