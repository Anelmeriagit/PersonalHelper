// Сценарий smoke.mjs --only=welcome (общие настройки и заглушки: smoke-lib.mjs, fixtures.mjs).
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';

// ---------- окно приветствия ----------
// Без флага welcome окно открывается один раз на браузер; кнопка и Esc закрывают его и ставят флаг; после перезагрузки его нет.

export async function welcome({ stand, browser, fail }) {
  for (const scheme of SCHEMES) {
    for (const vp of [...VIEWPORTS, { width: 360, height: 500 }]) { // низкий экран: длинный текст прокручивается внутри окна
      for (const loggedIn of [false, true]) {
        const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
        await ctx.addInitScript((s) => {
          try { localStorage.setItem('theme', s); } catch { /* нет доступа */ }
          window.__csp = [];
          document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
        }, scheme);
        const page = await ctx.newPage();
        const problems = [];
        page.on('pageerror', (e) => problems.push('JS: ' + e.message));
        page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) problems.push('console: ' + m.text()); });
        if (!loggedIn) await page.route('**/api/data', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"auth"}' }));
        const before = stand.unmocked.length;
        const check = (cond, msg) => { if (!cond) problems.push(msg); };
        const isOpen = () => page.evaluate(() => document.getElementById('welcome').open);
        const flag = () => page.evaluate(() => localStorage.getItem('welcome'));
        // событие close у <dialog> приходит чуть позже самого закрытия: флаг и фокус ждём, а не читаем сразу
        const flagSet = () => page.waitForFunction(() => localStorage.getItem('welcome') === '1', null, { timeout: 2000 }).then(() => true, () => false);
        const noHScroll = async (where) => {
          const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
          check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
        };
        const ready = () => page.waitForSelector('#mainNav', { state: 'visible', timeout: 5000 });
        try {
          await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
          await ready();
          check(await isOpen(), 'первый заход: окно не открылось');
          check((await page.locator('#wlcT').innerText()) === 'Добро пожаловать в Personal Helper', 'заголовок окна');
          check((await page.locator('#welcome').getAttribute('aria-labelledby')) === 'wlcT', 'у окна нет aria-labelledby');
          const hb = await page.locator('#wlcT').boundingBox();
          check(hb && hb.y >= 0 && hb.y + hb.height <= vp.height, 'заголовок окна не виден при открытии: ' + JSON.stringify(hb));
          const box = await page.locator('#welcome').boundingBox();
          check(box && box.x >= 0 && box.x + box.width <= vp.width && box.y >= 0 && box.y + box.height <= vp.height, 'окно не помещается в экран: ' + JSON.stringify(box));
          const bh = await page.locator('#welcome .done').evaluate((el) => el.getBoundingClientRect().height);
          check(bh >= 40, 'кнопка слишком мелкая: ' + Math.round(bh) + ' px');
          check((await flag()) === null, 'флаг welcome поставлен до закрытия окна');
          await noHScroll('окно приветствия');

          await page.click('#welcome .done');
          check(!(await isOpen()), 'кнопка не закрыла окно');
          check(await flagSet(), 'после закрытия кнопкой флаг welcome не поставлен');
          await noHScroll('после закрытия');

          await page.reload({ waitUntil: 'load' });
          await ready();
          await page.waitForTimeout(200);
          check(!(await isOpen()), 'после перезагрузки окно открылось снова');

          // Esc закрывает окно так же, как кнопка
          await page.evaluate(() => { localStorage.removeItem('welcome'); });
          await page.reload({ waitUntil: 'load' });
          await ready();
          check(await isOpen(), 'без флага окно не открылось после перезагрузки');
          await page.keyboard.press('Escape');
          check(!(await isOpen()), 'Esc не закрыл окно');
          check(await flagSet(), 'после Esc флаг welcome не поставлен');

          const csp = await page.evaluate(() => window.__csp);
          check(!csp.length, 'CSP: ' + csp.join('; '));
          check(stand.unmocked.length === before, 'нет заглушки API: ' + stand.unmocked.slice(before).join(', '));
        } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
        console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px ${String(vp.height).padStart(4)} высота  окно приветствия, ${loggedIn ? 'вошедший' : 'гость'}${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
        if (problems.length) fail();
        await ctx.close();
      }
    }
  }
}
