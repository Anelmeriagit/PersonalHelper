// Сценарий smoke.mjs --only=paircb: «Соединить аккаунты», часть 3: кэшбэк партнёра в две колонки, только на просмотр.
// Проверяет: две колонки с именами (своё слева, имя партнёра с HTML экранируется), у партнёра нет элементов правки, компактный вид,
// режим правки без колонки партнёра и запись только своих частей, разрыв из настроек, соединение по ссылке, обновление при возврате на вкладку
// (партнёр сменил данные, разорвал связь), нет партнёра в ответе (гость и старый сервер). Общее: smoke-lib.mjs, fixtures.mjs.
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';
import { mskDay } from './fixtures.mjs';

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID = '0123456789abcdef0123456789abcdef';
const MIN5 = 5 * 60 * 1000;
const PNAME = 'Анна <b>К</b>';

export async function paircb({ stand, browser, fail }) {
  const cur = mskDay(0).slice(0, 7);
  const own = { [cur]: [
    { bank: 'otp', items: [{ cat: 'Маркетплейсы', pct: '12' }, { cat: 'АЗС', pct: '5' }] },
    { bank: 'alfa', items: [{ cat: 'Маркетплейсы', pct: '5' }] },
    { bank: 'sber', items: [{ cat: 'Супермаркеты', pct: '10' }] },
  ] };
  const theirs = () => ({ [cur]: [
    { bank: 'halva', items: [{ cat: 'Аптеки', pct: '7' }, { cat: 'Маркетплейсы', pct: '3' }] },
    { bank: 'vtb', items: [{ cat: 'Книги', pct: '4' }] },
  ] });
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
      const puts = [];
      let partner = { linked: true, name: PNAME, data: { months: theirs() } }, noPartnerField = false, myName = '';
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) problems.push('console: ' + m.text()); });
      const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      await page.route('**/api/data', (r) => {
        const m = r.request().method();
        if (m === 'PUT') { const b = r.request().postDataJSON(); puts.push(b); return json(r, { ok: true, rev: Object.fromEntries(Object.keys(b.parts).map((k) => [k, (b.parts[k].base || 0) + 1])) }); }
        const body = { id: ID, name: myName, data: { months: own, custom: [] }, rev: {} };
        if (!noPartnerField) body.partner = partner;
        return json(r, body);
      });
      await page.route('**/api/auth', (r) => {
        const b = r.request().postDataJSON();
        if (b.action === 'me') return json(r, { id: ID, name: myName, email: '', tg: { linked: false }, partner: partner.linked ? { linked: true, name: partner.name } : { linked: false } });
        if (b.action === 'pair-drop') { partner = { linked: false }; return json(r, { partner }); }
        if (b.action === 'pair-join') { partner = { linked: true, name: 'Борис', data: { months: theirs() } }; return json(r, { partner: { linked: true, name: 'Борис' } }); }
        return json(r, { ok: true });
      });
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const cnt = (sel) => page.locator(sel).count();
      const noHScroll = async (where) => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
        const o = await page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('#bCur .pc'), (e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > window.innerWidth + 1).length);
        check(o === 0, `${where}: колонка шире экрана или своего места (${o})`);
      };
      const setVis = (v) => page.evaluate((x) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => x }); document.dispatchEvent(new Event('visibilitychange')); }, v);
      const back = async () => { await setVis('hidden'); await setVis('visible'); await page.waitForTimeout(200); };
      try {
        await page.clock.install({ time: new Date() });
        await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector('#bCur .pair', { timeout: 5000 });

        // ---------- блоки: две колонки с именами ----------
        check((await cnt('#bCur .pair .pc')) === 2, 'две колонки');
        const names = await page.locator('#bCur .pn').allInnerTexts();
        check(names[0] === 'Helper User' && names[1] === PNAME, 'имена в заголовках (своё слева, имя с HTML как текст): ' + JSON.stringify(names));
        check((await cnt('#bCur .pn b')) === 0, 'имя партнёра экранировано: тегов в заголовке нет');
        check((await cnt('#bCur .pc:nth-child(1) .blk')) === 3 && (await cnt('#bCur .pc:nth-child(2) .blk')) === 2, 'банки: у меня 3, у партнёра 2');
        check((await cnt('#bCur .pc:nth-child(2) select, #bCur .pc:nth-child(2) button, #bCur .pc:nth-child(2) input')) === 0, 'у партнёра нет элементов правки');
        const own1 = await page.locator('#bCur .pc:nth-child(1) .row.best').count();
        check(own1 === 1, 'подсветка считается внутри колонки человека: у меня один best');
        check((await cnt('#bCur .pc:nth-child(2) .row.best, #bCur .pc:nth-child(2) .row.dim')) === 0, 'у партнёра «Маркетплейсы» одна запись: без подсветки (мои банки в неё не входят)');
        const bx = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#bCur .pc'), (e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }));
        check(bx.length === 2 && bx[0][1] <= bx[1][0] + 1, 'колонки рядом, не перекрываются: ' + JSON.stringify(bx));
        await noHScroll('блоки');

        // ---------- компактный вид ----------
        await page.click('#vsw [data-v=compact]');
        check((await cnt('#bCur .pc .cmp')) === 2, 'компактно: у каждого человека свой список');
        check((await cnt('#bCur .pc:nth-child(2) .cc')) === 3, 'компактно: у партнёра три категории');
        await noHScroll('компактно');
        await page.click('#vsw [data-v=blocks]');

        // ---------- режим правки: партнёра нет, правка на всю ширину, в запись уходит только своё ----------
        await page.click('#editBtn');
        check((await cnt('#bCur .pair')) === 0 && (await cnt('#bCur select[data-k=bank]')) === 3, 'правка: колонки партнёра нет, выборы банков свои');
        await noHScroll('правка');
        await page.selectOption('#bCur select[data-k=pct] >> nth=0', '15');
        const req = page.waitForRequest((q) => q.method() === 'PUT' && /\/api\/data$/.test(q.url()), { timeout: 8000 }).catch(() => null);
        await page.click('[data-act=save]');
        await page.clock.fastForward(2500);
        await req;
        await page.waitForTimeout(300);
        check(puts.length === 1 && Object.keys(puts[0].parts).join() === cur, 'запись: только свой месяц: ' + JSON.stringify(Object.keys((puts[0] || {}).parts || {})));
        check(!JSON.stringify(puts).includes('Анна') && !JSON.stringify(puts).includes('halva'), 'в записи нет данных партнёра');
        check((await cnt('#bCur .pair')) === 1, 'после правки колонки возвращаются');

        // ---------- партнёр поменял данные: подтягивается при возврате на вкладку не раньше чем через 5 минут ----------
        partner = { linked: true, name: 'Анна', data: { months: { [cur]: [{ bank: 'sber', items: [{ cat: 'Такси и каршеринг', pct: '6' }] }] } } };
        await back();
        check((await page.locator('#bCur .pn').nth(1).innerText()) === PNAME, 'раньше 5 минут данные партнёра не обновляются');
        await page.clock.fastForward(MIN5 + 1000);
        await back();
        check((await page.locator('#bCur .pn').nth(1).innerText()) === 'Анна' && (await cnt('#bCur .pc:nth-child(2) .blk')) === 1, 'через 5 минут: новое имя и данные партнёра');

        // ---------- партнёр разорвал связь на другом устройстве ----------
        partner = { linked: false };
        await page.clock.fastForward(MIN5 + 1000);
        await back();
        check((await cnt('#bCur .pair')) === 0 && (await cnt('#bCur .col')) === 1, 'связь разорвана на другом устройстве: одна колонка без заголовка');
        check(!/Анна/.test(await page.locator('#stage').innerText()), 'данных партнёра на странице нет');

        // ---------- соединение по ссылке: колонка партнёра появляется сразу ----------
        await page.goto(stand.url + '/?join=' + TOKEN, { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector('#dlg[open]', { timeout: 8000 });
        check(/соединён с аккаунтом Борис/.test(await page.locator('#dlgMsg').innerText()), 'сообщение о соединении');
        await page.waitForSelector('#bCur .pair', { timeout: 5000 });
        check((await page.locator('#bCur .pn').nth(1).innerText()) === 'Борис', 'после соединения в кэшбэке имя партнёра');
        await page.click('#dlg .done');

        // ---------- «Разорвать» в настройках: колонка партнёра исчезает сразу ----------
        await page.click((vp.width <= 640 ? '#navAcct' : '#uBtn')); await page.click('#uMenu [data-u=settings]');
        await page.waitForSelector('#acctDlg [data-a=pdrop]', { timeout: 5000 });
        await page.click('#acctDlg [data-a=pdrop]');
        await page.click('#dlg .done');
        await page.waitForSelector('#acctDlg [data-a=share]', { timeout: 5000 });
        check((await cnt('#bCur .pair')) === 0, 'разрыв: колонки партнёра нет');
        await page.click('#acctDlg [data-a=close]');

        // ---------- переименование: подпись своей колонки (связь есть снова) ----------
        partner = { linked: true, name: 'Борис', data: { months: theirs() } };
        myName = '';
        await page.clock.fastForward(MIN5 + 1000);
        await back();
        await page.waitForSelector('#bCur .pair', { timeout: 5000 });

        // ---------- нет поля partner в ответе (старый ответ): одна колонка ----------
        noPartnerField = true;
        await page.clock.fastForward(MIN5 + 1000);
        await back();
        check((await cnt('#bCur .pair')) === 0 && (await cnt('#bCur .col')) === 1, 'ответ без partner: одна колонка');

        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  кэшбэк партнёра${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
