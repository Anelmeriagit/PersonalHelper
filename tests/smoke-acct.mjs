// Сценарий smoke.mjs --only=acct (общие настройки и заглушки: smoke-lib.mjs, fixtures.mjs).
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';

// ---------- аккаунт: кнопка Google, меню, окно «Настройки аккаунта», имя, отвязка Telegram, удаление, выход ----------

export async function acct({ stand, browser, fail }) {
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
      const posts = [];
      let tgDeleted = 0, meFail = false, name = '';
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of (400|401)/.test(m.text())) problems.push('console: ' + m.text()); });
      const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      await page.route('**/api/auth', (r) => {
        const b = r.request().postDataJSON(); posts.push(b);
        if (b.action === 'me') return meFail ? json(r, { error: 'bad request' }, 400) : json(r, { id: '0123456789abcdef0123456789abcdef', name, email: '<u>anna</u>@example.com', tg: tgDeleted ? { linked: false } : { linked: true, id: 123456789, username: 'anna_tg<i>x</i>' } });
        if (b.action === 'rename') { name = b.name; return json(r, { name }); }
        return json(r, { ok: true });
      });
      await page.route('**/api/tglink', (r) => { if (r.request().method() === 'DELETE') tgDeleted++; json(r, { linked: false }); });
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const text = (sel) => page.locator(sel).first().innerText();
      const vis = (sel) => page.locator(sel).first().isVisible();
      const noHScroll = async (where) => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
      };
      const isOpen = (sel) => page.locator(sel).evaluate((el) => el.open);
      const openSettings = async () => { await page.click((vp.width <= 640 ? '#navAcct' : '#uBtn')); await page.click('#uMenu [data-u=settings]'); await page.waitForSelector('#acctDlg .ar', { timeout: 5000 }); };
      try {
        // --- не вошли: кнопка Google в шапке справа ---
        await page.route('**/api/data', (r) => json(r, { error: 'auth' }, 401), { times: 1 });
        await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector('#gBtn', { state: 'visible', timeout: 5000 });
        check(await vis('#gBtn'), 'без входа: кнопка Google видна');
        check(!(await vis('#uWrap')), 'без входа: меню пользователя скрыто');
        check((await page.getAttribute('#gBtn', 'href')) === '/api/auth?action=google', 'ссылка кнопки Google: ' + (await page.getAttribute('#gBtn', 'href')));
        check(/Войти через Google/.test(await page.locator('#gBtn').textContent()) && (await page.getAttribute('#gBtn', 'aria-label')) === 'Войти через Google', 'текст кнопки Google');
        const gb = await page.locator('#gBtn').boundingBox(), tb = await page.locator('#themeBtn').boundingBox();
        check(gb && tb && tb.x + tb.width <= gb.x && gb.x + gb.width <= vp.width && gb.height >= 44, 'кнопка Google справа от переключателя темы, не выходит за экран, высота ≥ 44 px');
        check(gb && gb.x > vp.width / 2 - gb.width, 'кнопка Google в правой части шапки');
        await noHScroll('без входа');

        // --- вошли: «Helper User» и галочка ---
        await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector((vp.width <= 640 ? '#navAcct' : '#uBtn'), { state: 'visible', timeout: 5000 });
        check(!(await vis('#gBtn')), 'после входа кнопка Google скрыта');
        check((await text('#uName')) === 'Helper User', 'имя в шапке по умолчанию: «' + (await text('#uName')) + '»');
        check((await page.locator('#uBtn svg').count()) === 1, 'у кнопки есть галочка');
        check((await page.locator('#outBtn').count()) === 0, 'старой кнопки выхода нет');
        const MOB = vp.width <= 640, TRIG = MOB ? '#navAcct' : '#uBtn';
        const brand = await page.locator('.brand').boundingBox();
        check((await text('.brand')).replace(/\s+/g, ' ').trim().endsWith('Your Personal Helper') && brand && brand.x < 40 + (vp.width > 1000 ? 400 : 20) && brand.x + brand.width <= vp.width, 'в шапке слева подпись «Your Personal Helper» со значком');
        if (MOB) {
          const na = await page.locator('#navAcct').boundingBox(), nv = await page.locator('#mainNav').boundingBox();
          check(await vis('#navAcct') && !(await vis('#uBtn')) && /Аккаунт/.test(await text('#navAcct')), 'телефон: в нижней панели «Аккаунт», кнопки с именем в шапке нет');
          check(na && nv && na.y >= nv.y && na.x + na.width <= vp.width + 1 && na.x > vp.width / 2, 'телефон: «Аккаунт» в нижней панели, последним');
        } else {
          const ub = await page.locator('#uBtn').boundingBox(), tb2 = await page.locator('#themeBtn').boundingBox();
          check(ub && ub.height >= 44 && ub.x + ub.width <= vp.width, 'кнопка пользователя: высота ≥ 44 px, не выходит за экран');
          check(ub && tb2 && tb2.x + tb2.width <= ub.x, 'компьютер: кнопка пользователя правее переключателя темы');
          check(!(await vis('#navAcct')), 'компьютер: «Аккаунт» в нижней панели не показывается');
          const al = await page.evaluate(() => { const b = document.getElementById('uBtn').getBoundingClientRect(), r = document.createRange(); r.selectNodeContents(document.getElementById('uName')); const t = r.getBoundingClientRect(); return Math.abs((t.top + t.bottom) / 2 - (b.top + b.bottom) / 2); });
          check(al <= 2.5, 'имя по высоте в центре кнопки, отклонение ' + al.toFixed(1) + ' px');
        }
        await noHScroll('шапка вошедшего');

        // --- меню ---
        await page.click(TRIG);
        check(await vis('#uMenu'), 'меню открывается');
        check((await page.getAttribute(TRIG, 'aria-expanded')) === 'true', 'aria-expanded=true');
        check((await page.locator('#uMenu [role=menuitem]').allInnerTexts()).join('|') === 'Настройки аккаунта|Выйти', 'пункты меню');
        const mb = await page.locator('#uMenu').boundingBox();
        check(mb && mb.x >= 0 && mb.x + mb.width <= vp.width, 'меню внутри экрана');
        if (MOB) { const nv2 = await page.locator('#mainNav').boundingBox(); check(mb && nv2 && mb.y + mb.height <= nv2.y, 'телефон: меню открывается над нижней панелью'); }
        await page.keyboard.press('Escape');
        check(!(await vis('#uMenu')) && (await page.evaluate(() => document.activeElement.id)) === TRIG.slice(1), 'Escape закрывает меню и возвращает фокус');
        await page.click(TRIG);
        await page.mouse.click(4, 400);
        check(!(await vis('#uMenu')), 'клик вне меню закрывает его');

        // --- окно настроек: ошибка загрузки ---
        meFail = true; await page.click((vp.width <= 640 ? '#navAcct' : '#uBtn')); await page.click('#uMenu [data-u=settings]');
        await page.waitForFunction(() => /Не удалось загрузить/.test(document.getElementById('acctDlg').innerText), null, { timeout: 5000 });
        await page.click('#acctDlg [data-a=close]');
        check(!(await isOpen('#acctDlg')), 'окно закрывается крестиком');
        meFail = false;

        // --- окно настроек ---
        await openSettings();
        check(await isOpen('#acctDlg'), 'окно настроек открыто');
        check(posts.some((b) => b.action === 'me'), 'запрос me');
        check((await text('#acName')) === 'Helper User', 'в окне имя по умолчанию');
        check((await text('#acctDlg .vid')) === '0123456789abcdef0123456789abcdef', 'Account ID');
        const dlgT = await page.locator('#acctDlg').innerText();
        check(/<u>anna<\/u>@example\.com/.test(dlgT), 'Email показан текстом');
        check(!/ID 123456789/.test(dlgT) && /@anna_tg<i>x<\/i>/.test(dlgT), 'Telegram: ID не показан, имя текстом');
        check((await page.locator('#acctDlg u, #acctDlg i').count()) === 0, 'Email и имя Telegram не создают разметку (экранирование)');
        check((await page.locator('#acctDlg [data-a=unlink]').count()) === 1, 'кнопка «Отвязать»');
        check(/Соединить аккаунты/.test(dlgT) && (await page.locator('#acctDlg .ar [data-a=share]').count()) === 1 && (await page.locator('#acctDlg .ar button[disabled]').count()) === 0, 'поле «Соединить аккаунты»: кнопка «Поделиться»');
        check((await text('#acctDlg .dz .done')) === 'ПЕРМАНЕНТНОЕ УДАЛЕНИЕ АККАУНТА', 'красная кнопка удаления');
        const ys = await page.evaluate(() => {
          const q = (s) => document.querySelector('#acctDlg ' + s).getBoundingClientRect();
          const rows = [...document.querySelectorAll('#acctDlg .ar')].map((e) => e.getBoundingClientRect().top);
          return { rows, dz: q('.dz').top, nm: q('#acName'), btn: q('[data-a=rename]'), lab: q('.al'), dlg: document.getElementById('acctDlg').getBoundingClientRect(), sw: document.getElementById('acctDlg').scrollWidth, cw: document.getElementById('acctDlg').clientWidth, bc: getComputedStyle(document.querySelector('#acctDlg .dz')).borderTopColor, ih: innerHeight, iw: innerWidth };
        });
        check(ys.rows.length === 5 && ys.rows.every((y, i, a) => i === 0 || y > a[i - 1]) && ys.dz > ys.rows[4], 'порядок: имя, Email, ID, Telegram, соединить, удаление');
        check(ys.nm.top > ys.lab.top && ys.btn.left > ys.nm.right, 'имя под подписью, кнопка «Изменить» правее имени');
        check(Math.abs(ys.dlg.left + ys.dlg.width / 2 - ys.iw / 2) <= 2 && ys.dlg.left >= 0 && ys.dlg.right <= ys.iw, 'окно по центру по горизонтали и в экране');
        check(ys.dlg.height >= ys.ih - 1 || Math.abs(ys.dlg.top + ys.dlg.height / 2 - ys.ih / 2) <= 2, 'окно по центру по вертикали (или на всю высоту)');
        check(ys.sw <= ys.cw, `в окне горизонтальная прокрутка ${ys.sw} > ${ys.cw}`);
        const [r, g, b] = ys.bc.match(/\d+/g).map(Number);
        check(r > 150 && g < 150 && b < 150, 'рамка блока удаления красная: ' + ys.bc);
        await noHScroll('окно настроек');

        // --- имя ---
        await page.click('#acctDlg [data-a=rename]');
        check((await page.locator('#acIn').count()) === 1, 'поле имени появилось');
        await page.fill('#acIn', '  Анна   К ');
        await page.click('#acctDlg [data-a=save]');
        await page.waitForFunction(() => document.getElementById('acName') && document.getElementById('acName').textContent === 'Анна К', null, { timeout: 5000 });
        check(JSON.stringify(posts.filter((x) => x.action === 'rename').pop()) === JSON.stringify({ action: 'rename', name: 'Анна К' }), 'запрос rename: пробелы убраны');
        check((await text('#uName')) === 'Анна К', 'имя в шапке обновилось');
        await page.click('#acctDlg [data-a=rename]');
        await page.fill('#acIn', 'Ж'.repeat(40));
        check((await page.inputValue('#acIn')).length === 32, 'в поле не больше 32 символов');
        await page.click('#acctDlg [data-a=save]');
        await page.waitForFunction(() => document.getElementById('acName') && document.getElementById('acName').textContent.length === 32, null, { timeout: 5000 });
        await noHScroll('длинное имя');
        await page.click('#acctDlg [data-a=rename]');
        await page.fill('#acIn', '<b>x</b><img src=x onerror=alert(1)>');
        await page.click('#acctDlg [data-a=save]');
        await page.waitForFunction(() => document.getElementById('acName') && document.getElementById('acName').textContent.indexOf('<b>') === 0, null, { timeout: 5000 });
        check((await page.locator('#uBtn b, #uBtn img, #acctDlg b, #acctDlg img').count()) === 0, 'имя с тегами выводится текстом, не разметкой');
        await page.click('#acctDlg [data-a=rename]');
        await page.click('#acctDlg [data-a=cancel]');
        check((await page.locator('#acIn').count()) === 0, 'отмена закрывает поле имени');
        await page.click('#acctDlg [data-a=rename]');
        await page.fill('#acIn', '');
        await page.click('#acctDlg [data-a=save]');
        await page.waitForFunction(() => document.getElementById('acName') && document.getElementById('acName').textContent === 'Helper User', null, { timeout: 5000 });
        check((await text('#uName')) === 'Helper User', 'пустое имя возвращает «Helper User»');

        // --- отвязка Telegram: отмена, затем подтверждение ---
        await page.click('#acctDlg [data-a=unlink]');
        await page.waitForSelector('#dlg[open]', { timeout: 5000 });
        await page.click('#dlgNo');
        check(tgDeleted === 0 && (await page.locator('#acctDlg [data-a=unlink]').count()) === 1, 'отмена не отвязывает');
        await page.click('#acctDlg [data-a=unlink]');
        await page.waitForSelector('#dlg[open]', { timeout: 5000 });
        await page.click('#dlg .done');
        await page.waitForFunction(() => !document.querySelector('#acctDlg [data-a=unlink]'), null, { timeout: 5000 });
        check(tgDeleted === 1, 'DELETE /api/tglink отправлен один раз');
        check(!/Telegram/.test(await page.locator('#acctDlg').innerText()), 'поле Telegram исчезло после отвязки');

        // --- удаление аккаунта ---
        await page.click('#acctDlg [data-a=del]');
        await page.waitForSelector('#delDlg[open]', { timeout: 5000 });
        check(/Удалить аккаунт навсегда/.test(await text('#delDlg h2')) && /удалить/.test(await text('#delDlg label')), 'окно удаления: предупреждение и слово');
        check(await page.locator('#delGo').isDisabled(), 'кнопка удаления недоступна, пока слово не введено');
        await page.fill('#delIn', 'удал');
        check(await page.locator('#delGo').isDisabled(), 'часть слова не подходит');
        await page.click('#delDlg [data-d=no]');
        check(!(await isOpen('#delDlg')) && (await isOpen('#acctDlg')), 'отмена закрывает только окно удаления');
        await page.click('#acctDlg [data-a=del]');
        await page.waitForSelector('#delDlg[open]', { timeout: 5000 });
        check((await page.inputValue('#delIn')) === '', 'поле слова пустое при повторном открытии');
        await page.fill('#delIn', ' Удалить ');
        check(!(await page.locator('#delGo').isDisabled()), 'слово «Удалить» (любой регистр, с пробелами) подходит');
        await noHScroll('окно удаления');
        const before = posts.length;
        await page.click('#delGo');
        await page.waitForSelector('#gBtn', { state: 'visible', timeout: 5000 });
        check(JSON.stringify(posts[before]) === JSON.stringify({ action: 'delete', confirm: 'удалить' }), 'запрос delete: ' + JSON.stringify(posts[before]));
        check(!(await isOpen('#acctDlg')) && !(await isOpen('#delDlg')), 'после удаления окна закрыты');
        await page.waitForSelector('#dlg[open]', { timeout: 5000 });
        check(/Аккаунт удалён/.test(await text('#dlgMsg')), 'сообщение «Аккаунт удалён»');
        await page.click('#dlg .done');
        check((await vis('#gBtn')) && !(await vis('#uWrap')), 'после удаления снова кнопка Google');

        // --- выход через меню ---
        await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector((vp.width <= 640 ? '#navAcct' : '#uBtn'), { state: 'visible', timeout: 5000 });
        await page.click((vp.width <= 640 ? '#navAcct' : '#uBtn')); await page.click('#uMenu [data-u=logout]');
        await page.waitForSelector('#gBtn', { state: 'visible', timeout: 5000 });
        check(posts.filter((x) => x.action === 'logout').length === 1, 'запрос logout');
        check(await vis('#gBtn'), 'после выхода кнопка Google');
        // --- возврат от Google с ошибкой: окно с текстом по коду, адрес очищается, из адреса ничего не выводится ---
        for (const [q, re, label] of [['denied', /Вход через Google отменён/, 'denied'], ['state', /Нажмите «Войти через Google» ещё раз/, 'state'], ['full', /лимит пользователей/, 'full'], ['%3Cb%3Ex%3C%2Fb%3E', null, 'неизвестный код']]) {
          await page.route('**/api/data', (r) => json(r, { error: 'auth' }, 401), { times: 1 });
          await page.goto(stand.url + '/?gerr=' + q + '#wifi', { waitUntil: 'load', timeout: 15000 });
          await page.waitForSelector('#gBtn', { state: 'visible', timeout: 5000 });
          if (re) {
            await page.waitForSelector('#dlg[open]', { timeout: 5000 });
            check(re.test(await text('#dlgMsg')), 'сообщение после возврата от Google (' + label + '): ' + (await text('#dlgMsg')));
            await page.click('#dlg .done');
          } else {
            check(!(await isOpen('#dlg')), 'неизвестный код: сообщения нет');
          }
          check((await page.locator('#dlgMsg b, #lf b').count()) === 0, 'код из адреса не создаёт разметку (' + label + ')');
          check(!/gerr/.test(page.url()) && /#wifi$/.test(page.url()), 'адрес очищен от gerr, hash сохранён (' + label + '): ' + page.url());
          check(await vis('#gBtn'), 'после возврата видна кнопка Google (' + label + ')');
        }
        await noHScroll('сообщение Google');
        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  аккаунт: Google, меню, настройки${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
