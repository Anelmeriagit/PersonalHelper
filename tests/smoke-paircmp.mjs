// Сценарий smoke.mjs --only=paircmp: «Соединить аккаунты», третья колонка «Сравнение» в кэшбэке.
// Проверяет: у соединённых аккаунтов три колонки (своя, партнёра, «Сравнение»; на 1280 px в один ряд, на 360 px сравнение под двумя), переключателя вида нет,
// в таблице «категория — свой лучший процент — лучший процент партнёра» у кого выше — best, у другого dim, ничья — оба best, запись только у одного — без подсветки и «—»,
// в блоках подсветки нет, имя партнёра с HTML экранируется, режим правки без колонок, без партнёра и при пустых месяцах таблицы нет, нет горизонтальной прокрутки.
// Общее: smoke-lib.mjs, fixtures.mjs.
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';
import { mskDay } from './fixtures.mjs';

const ID = '0123456789abcdef0123456789abcdef';
const PNAME = 'Анна <b>К</b>';

export async function paircmp({ stand, browser, fail }) {
  const cur = mskDay(0).slice(0, 7);
  const own = { [cur]: [
    { bank: 'otp', items: [{ cat: 'Маркетплейсы', pct: '12' }, { cat: 'АЗС', pct: '5' }] },
    { bank: 'alfa', items: [{ cat: 'Маркетплейсы', pct: '5' }] },
    { bank: 'sber', items: [{ cat: 'Супермаркеты', pct: '10' }] },
  ] };
  const theirs = { [cur]: [
    { bank: 'halva', items: [{ cat: 'Аптеки', pct: '7' }, { cat: 'Маркетплейсы', pct: '3' }] },
    { bank: 'vtb', items: [{ cat: 'Книги', pct: '4' }, { cat: 'АЗС', pct: '5' }] },
    { bank: 'tbank', items: [{ cat: 'АЗС', pct: '5' }] },
  ] };
  for (const scheme of SCHEMES) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, timezoneId: 'Europe/Moscow' });
      await ctx.addInitScript((s) => {
        try { localStorage.setItem('theme', s); localStorage.setItem('welcome', '1'); } catch { /* нет доступа */ }
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
      }, scheme);
      const page = await ctx.newPage();
      const problems = [];
      const puts = [];
      let partner = { linked: true, name: PNAME, data: { months: theirs } };
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) problems.push('console: ' + m.text()); });
      const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      await page.route('**/api/data', (r) => {
        if (r.request().method() === 'PUT') { puts.push(r.request().postDataJSON()); return json(r, { ok: true, rev: {} }); }
        return json(r, { id: ID, name: '', data: { months: own, custom: [] }, rev: {}, partner });
      });
      await page.route('**/api/auth', (r) => json(r, { id: ID, name: '', email: '', tg: { linked: false }, partner: { linked: false } }));
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const cnt = (sel) => page.locator(sel).count();
      const noHScroll = async (where) => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
        const o = await page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('#bCur .vs, #bCur .vc, #bCur .vk'), (e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > window.innerWidth + 1).length);
        check(o === 0, `${where}: таблица или ячейка шире экрана или своего места (${o})`);
      };
      const rowCls = (i) => page.locator('#bCur .vr').nth(i).locator('.vc').evaluateAll((es) => es.map((e) => e.className.replace('vc', '').trim()));
      const pressed = () => page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('#vsw button'), (b) => b.getAttribute('aria-pressed') === 'true' && !b.hidden).map((b) => b.dataset.v).join());
      try {
        await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector('#bCur .pair', { timeout: 5000 });

        // ---------- три колонки, переключателя нет ----------
        check((await cnt('#vsw')) === 0, 'переключателя вида нет');
        check((await cnt('#bCur .pair.p3 > .pc')) === 3 && (await cnt('#bCur .pair > .pc.pcv .vs')) === 1, 'три колонки: своя, партнёра, «Сравнение»');
        const pn = await page.locator('#bCur .pn').allInnerTexts();
        check(pn.length === 3 && pn[0] === 'Helper User' && pn[1] === PNAME && pn[2] === 'Сравнение', 'заголовки колонок (имя с HTML как текст): ' + JSON.stringify(pn));
        check((await cnt('#bCur .pn b')) === 0 && (await cnt('#bCur .vh b')) === 0, 'имя партнёра экранировано');
        check((await cnt('#bCur .pc:not(.pcv) .row.best, #bCur .pc:not(.pcv) .row.dim')) === 0, 'в блоках подсветки нет');
        check((await cnt('#bCur .pc:nth-child(1) .blk')) === 3 && (await cnt('#bCur .pc:nth-child(2) .blk')) === 3, 'блоки: у меня 3 банка, у партнёра 3');
        const box = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#bCur .pair > .pc'), (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right)]; }));
        if (vp.width >= 1000) check(box[0][1] === box[2][1] && box[0][2] <= box[1][0] + 1 && box[1][2] <= box[2][0] + 1, 'на широком экране три колонки в одном ряду: ' + JSON.stringify(box));
        else check(box[0][1] === box[1][1] && box[2][1] > box[0][1] && box[2][0] <= box[0][0] + 1, 'на узком экране две колонки рядом, сравнение под ними: ' + JSON.stringify(box));
        const heads = await page.locator('#bCur .vh [role=columnheader]').allInnerTexts();
        check(heads.length === 3 && heads[1] === 'Helper User' && heads[2] === PNAME, 'заголовки таблицы: ' + JSON.stringify(heads));
        const cats = await page.locator('#bCur .vk').allInnerTexts();
        check(cats.join('|') === 'АЗС|Аптеки|Книги|Маркетплейсы|Супермаркеты', 'категории обоих по алфавиту: ' + cats.join('|'));
        check(JSON.stringify(await rowCls(0)) === '["best","best"]', 'АЗС 5% и 5%: ничья, оба best');
        check(JSON.stringify(await rowCls(1)) === '["",""]' && (await cnt('#bCur .vr:nth-child(3) .vn')) === 1, 'Аптеки: только у партнёра, без подсветки, у меня «—»');
        check(JSON.stringify(await rowCls(3)) === '["best","dim"]', 'Маркетплейсы 12% и 3%: у меня best, у партнёра dim');
        check((await cnt('#bCur .vr:nth-child(6) .vn')) === 1 && JSON.stringify(await rowCls(4)) === '["",""]', 'Супермаркеты: только у меня, у партнёра «—»');
        const mk = await page.locator('#bCur .vr').nth(3).locator('.vc').allInnerTexts();
        check(/12%/.test(mk[0]) && /3%/.test(mk[1]) && !/5%/.test(mk[0]), 'в ячейке лучший процент, а не второй: ' + JSON.stringify(mk));
        check((await cnt('#bCur .vr')) === 5, 'пять строк');
        check((await page.locator('#bCur .vr').nth(0).locator('.vc').nth(1).locator('.mb').count()) === 2, 'АЗС у партнёра: два банка с лучшим процентом');
        await noHScroll('три колонки');

        // ---------- режим правки: колонок нет, правка своя ----------
        await page.click('#editBtn');
        check((await cnt('#bCur .vs')) === 0 && (await cnt('#bCur .pair')) === 0 && (await cnt('#bCur select[data-k=bank]')) === 3, 'правка: колонок нет, выборы банков свои');
        await page.click('#editBtn');
        await page.waitForTimeout(300);
        check((await cnt('#bCur .vs')) === 1 && puts.length === 0, 'после правки без изменений колонки вернулись, записи нет');

        // ---------- разрыв связи: одна колонка ----------
        partner = { linked: false };
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#bCur .col', { timeout: 5000 });
        check((await cnt('#bCur .vs')) === 0 && (await cnt('#bCur .pair')) === 0 && (await cnt('#bCur .col')) === 1, 'без партнёра: одна колонка, сравнения нет');
        await noHScroll('без партнёра');

        // ---------- партнёр без данных за месяц: в сравнении мои категории, партнёру «—» ----------
        partner = { linked: true, name: 'Борис', data: { months: {} } };
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#bCur .vs', { timeout: 5000 });
        check((await cnt('#bCur .vr')) === 3 && (await cnt('#bCur .vr .vn')) === 3, 'партнёр пуст: три моих категории, у партнёра «—»');
        // ---------- у обоих пусто: прежняя пара колонок («Пусто» / «+ Добавить») ----------
        await page.unroute('**/api/data');
        await page.route('**/api/data', (r) => json(r, { id: ID, name: '', data: { months: {}, custom: [] }, rev: {}, partner }));
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#bCur .pair', { timeout: 5000 });
        check((await cnt('#bCur .vs')) === 0 && (await cnt('#bCur .pair.p3')) === 0 && (await cnt('#bCur .pair > .pc')) === 2 && (await cnt('#bCur .addbtn')) === 1, 'у обоих пусто: сравнения нет, у меня «+ Добавить», у партнёра «Пусто»');

        const csp = await page.evaluate(() => window.__csp);
        check(csp.length === 0, 'нарушения CSP: ' + csp.join('; '));
      } catch (e) { problems.push('исключение: ' + e.message); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  колонка «Сравнение»${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
