// Общий проход smoke.mjs без --only: каждая страница × 360/1280 px × светлая/тёмная тема (CSP, ошибки JS, незамоканный API, горизонтальная прокрутка).
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';

const PAGES = [['главная', ''], ['напоминания', '#reminders'], ['wifi', '#wifi'], ['агент', '#agent']];

export async function pages({ stand, browser, fail }) {
  for (const scheme of SCHEMES) {
    for (const vp of VIEWPORTS) {
      for (const [name, hash] of PAGES) {
        const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
        // Тема в приложении хранится в localStorage (ключ theme); значение подбираем по схеме.
        await ctx.addInitScript((s) => {
          try { localStorage.setItem('theme', s); localStorage.setItem('welcome', '1'); } catch { /* нет доступа */ }
          window.__csp = [];
          document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
        }, scheme);
        const page = await ctx.newPage();
        const problems = [];
        page.on('pageerror', (e) => problems.push('JS: ' + e.message));
        page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
        const before = stand.unmocked.length;

        // Таймауты не должны ронять весь прогон: фиксируем как замечание и идём дальше.
        try { await page.goto(stand.url + '/' + hash, { waitUntil: 'load', timeout: 15000 }); }
        catch (e) { problems.push('загрузка: ' + e.message.split('\n')[0]); }
        try { await page.waitForLoadState('networkidle', { timeout: 5000 }); }
        catch { problems.push('сеть не успокоилась за 5 с (запрос завис или тело ответа не прочитано)'); }
        await page.waitForTimeout(300);

        const r = await page.evaluate(() => ({
          csp: window.__csp,
          sw: document.documentElement.scrollWidth,
          iw: window.innerWidth,
          theme: document.documentElement.getAttribute('data-theme') || document.documentElement.className || '(не задана)',
        }));
        if (!(await page.locator('#mainNav').isVisible())) problems.push('навигация скрыта у вошедшего пользователя');
        if (r.csp.length) problems.push('CSP: ' + r.csp.join('; '));
        if (r.sw > r.iw) problems.push(`горизонтальная прокрутка: ${r.sw} > ${r.iw}`);
        if (stand.unmocked.length > before) problems.push('нет заглушки API: ' + stand.unmocked.slice(before).join(', '));

        const status = problems.length ? 'FAIL' : 'ok  ';
        console.log(`${status} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  ${name.padEnd(12)} тема: ${r.theme}${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
        if (problems.length) fail();
        await ctx.close();
      }
    }
  }
}
