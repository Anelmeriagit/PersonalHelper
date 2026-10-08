// Сценарий smoke.mjs --only=cashback (общие настройки и заглушки: smoke-lib.mjs, fixtures.mjs).
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';

// ---------- кэшбэк для одного человека ----------

export async function cashback({ stand, browser, fail }) {
  for (const scheme of SCHEMES) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
      await ctx.addInitScript((s) => {
        try { localStorage.setItem('theme', s); localStorage.setItem('welcome', '1'); localStorage.removeItem('view'); } catch { /* нет доступа */ }
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
      }, scheme);
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const noHScroll = async (where) => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
      };
      try {
        await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector('#bCur .col', { timeout: 5000 });
        check((await page.locator('#bCur .col').count()) === 1, 'блоки: одна колонка на месяц');
        check((await page.locator('#bCur .col h3').count()) === 0, 'блоки: нет заголовка с именем человека');
        check((await page.locator('#bCur .blk').count()) === 3, 'блоки: три банка из заглушки');
        const stageText = await page.locator('#stage').innerText();
        check(!/Жанна|Денис/.test(stageText), 'на странице кэшбэка нет имён Жанна/Денис');
        check((await page.locator('#bCur .row.best').count()) === 1 && (await page.locator('#bCur .row.dim').count()) === 1, 'подсветка: в «Маркетплейсы» лучший 12% и приглушённый 5%');
        await noHScroll('блоки');

        await page.click('#vsw [data-v=compact]');
        check((await page.locator('#bCur .cmp .cc').count()) === 3, 'компактно: три категории');
        check((await page.locator('#bCur .cl').count()) === 0, 'компактно: нет букв Ж/Д');
        check((await page.locator('#bCur .cg.best').count()) === 1 && (await page.locator('#bCur .cg.dim').count()) === 1, 'компактно: подсветка best/dim');
        check(/12%/.test(await page.locator('#bCur .cmp').innerText()), 'компактно: проценты видны');
        await noHScroll('компактно');
        await page.click('#vsw [data-v=blocks]');

        await page.click('#editBtn');
        check((await page.locator('#bCur select[data-k=bank]').count()) === 3, 'правка: три выбора банка');
        check((await page.locator('#stage [data-p]').count()) === 0, 'правка: у элементов нет data-p');
        await noHScroll('правка');
        await page.click('[data-act=discard]');
        check((await page.locator('#bCur .blk').count()) === 3, 'выход из правки без изменений');
        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  кэшбэк, один человек${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
