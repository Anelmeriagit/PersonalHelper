// Сценарий smoke.mjs --only=shared: «Соединить аккаунты», часть 5: третья колонка «Общие» на вкладке «Напоминания».
// Проверяет: колонка есть только при соединённых аккаунтах (три колонки на 1280 px, друг под другом на 360 px), имя партнёра и тексты экранированы,
// у общего две галочки (своя и партнёра, менять может любой), тела запросов с shared:true и who, создание с двумя включёнными галочками, правка, удаление,
// отправленное нельзя менять, личные запросы без shared, ответ сервера 409 nopair (связь разорвана) убирает колонку, нет shared в ответе (не соединён).
// Общее: smoke-lib.mjs, fixtures.mjs.
import { mskDay } from './fixtures.mjs';
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';

const PNAME = 'Анна <b>К</b>';

export async function shared({ stand, browser, fail }) {
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
      let seq = 0; // id созданных записей: уникальные, даже после удаления
      const tomorrow = mskDay(1);
      const state = {
        custom: [{ id: 'aaaaaaaaaaaa', date: mskDay(3), slot: 'day', text: 'Личное', on: true, sent: false }],
        recurring: [],
        shared: {
          linked: true, name: PNAME,
          custom: [
            { id: 'dddddddddddd', date: mskDay(4), slot: 'evening', text: 'Купить <i>торт</i>', on: true, pon: true, sent: false, psent: false },
            { id: 'cccccccccccc', date: mskDay(0), slot: 'day', text: 'Уже ушло', on: true, pon: true, sent: true, psent: false },
          ],
          recurring: [{ id: 'ffffffffffff', date: mskDay(2), every: 'month', slot: 'day', text: 'Платёж', on: true, pon: false, next: mskDay(2) }],
        },
        broken: false,
      };
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) problems.push('console: ' + m.text()); });
      const view = () => JSON.stringify({ linked: true, custom: state.custom, recurring: state.recurring, ...(state.shared ? { shared: state.shared } : {}) });
      await page.route('**/api/reminders', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: view() }));
      for (const kind of ['custom', 'recurring']) {
        await page.route('**/api/' + kind + '*', (r) => {
          const req = r.request(), m = req.method(), u = new URL(req.url());
          const body = m === 'DELETE' ? null : req.postDataJSON();
          const sh = m === 'DELETE' ? u.searchParams.get('shared') === '1' : !!(body && body.shared === true);
          calls.push([m, kind, sh, body || u.searchParams.get('id'), u.search]);
          if (sh && (state.broken || !state.shared)) { state.shared = null; return r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'nopair' }) }); }
          const list = sh ? state.shared[kind] : state[kind];
          if (m === 'POST') {
            const b = { ...body }; delete b.shared;
            list.push({ id: String(++seq).padStart(12, sh ? 'd' : 'c'), on: true, ...(sh ? { pon: true } : {}), ...(kind === 'custom' ? { sent: false, ...(sh ? { psent: false } : {}) } : b.days ? { every: 'month', date: tomorrow, next: tomorrow } : { next: b.date }), ...b });
          } else if (m === 'PUT') {
            const it = list.find((x) => x.id === body.id);
            if (it && body.key === 'on') { if (sh && body.who === 'partner') it.pon = body.value; else it.on = body.value; }
            else if (it) { if ('text' in body) it.text = body.text; }
          } else {
            const id = u.searchParams.get('id');
            if (sh) state.shared[kind] = state.shared[kind].filter((x) => x.id !== id); else state[kind] = state[kind].filter((x) => x.id !== id);
          }
          r.fulfill({ status: 200, contentType: 'application/json', body: view() });
        });
      }
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const cnt = (sel) => page.locator(sel).count();
      const noHScroll = async (where) => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
        const o = await page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('#shrCol .rc, #shrCol .fm'), (e) => e.getBoundingClientRect().right > window.innerWidth + 1).length);
        check(o === 0, `${where}: карточка или форма шире экрана (${o})`);
      };
      const pickDay = async (formSel) => {
        if ((await cnt(`${formSel} [data-d="${tomorrow}"]`)) === 0) await page.click(`${formSel} [data-nav="1"]`);
        await page.click(`${formSel} [data-d="${tomorrow}"]`);
      };
      const save = async (formSel) => { await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await page.locator(formSel + ' [data-f=save]').evaluate((el) => el.scrollIntoView({ block: 'center' })); await page.click(formSel + ' [data-f=save]'); };
      const arm = () => page.evaluate(() => { document.getElementById('remMsg').textContent = ''; });
      const lastCall = (m, kind) => calls.filter((c) => c[0] === m && c[1] === kind).pop();
      const saved = () => page.waitForFunction(() => /Сохранено/.test(document.getElementById('remMsg').textContent), null, { timeout: 5000 });
      try {
        await page.goto(stand.url + '/#reminders', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector('#shrCol:not([hidden]) #shrTmpList .rc', { timeout: 5000 });

        // ---------- разметка ----------
        check((await page.locator('#remStage .rgrp:not([hidden])').count()) === 2 && (await page.locator('#remStage .rgrp:not([hidden]) .rcol').count()) === 4, 'две рамки, в каждой две колонки');
        const box = (sel) => page.locator(sel).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)]; }));
        const xs = await box('#remStage .rgrp:not([hidden]) .rcol'), fr = await box('#remStage .rgrp:not([hidden])');
        if (vp.width >= 1100) check(fr[0][0] < fr[1][0] && fr[0][1] === fr[1][1], 'на 1280 px рамки рядом: ' + JSON.stringify(fr));
        else check(fr[0][0] === fr[1][0] && fr[0][1] < fr[1][1], 'на 360 px рамки друг под другом: ' + JSON.stringify(fr));
        if (vp.width >= 1100) check(xs[0][1] === xs[2][1] && xs[1][1] === xs[3][1], 'колонки «Личных» и «Общих» начинаются на одной высоте: ' + JSON.stringify(xs));
        if (vp.width >= 600) check(xs[0][0] < xs[1][0] && xs[0][1] === xs[1][1] && xs[2][0] < xs[3][0] && xs[2][1] === xs[3][1], 'в рамке повторяющиеся слева, временные справа: ' + JSON.stringify(xs));
        else check(xs[0][0] === xs[1][0] && xs[1][1] < xs[2][1], 'на 360 px колонки друг под другом: ' + JSON.stringify(xs));
        check(await page.locator('#rcols').evaluate((e) => Array.prototype.every.call(e.querySelectorAll('.rgrp'), (g) => getComputedStyle(g).borderTopWidth !== '0px' && parseFloat(getComputedStyle(g).borderTopLeftRadius) >= 12)), 'у обеих рамок есть граница и скругление');
        if (vp.width >= 1100) check(Math.abs(fr[0][2] - fr[1][2]) <= 1 && xs[0][2] < 345 && xs[0][2] > 240, 'рамки одной ширины, колонка уже прежней (345 px), но не тесная: ' + xs[0][2]);
        check((await page.locator('#shrWith').innerText()) === 'Вместе с «' + PNAME + '»', 'подпись с именем партнёра: ' + (await page.locator('#shrWith').innerText()));
        check((await cnt('#shrCol b, #shrCol i')) === 0, 'имя и тексты экранированы: тегов нет');
        check((await cnt('#shrTmpList .rc')) === 2 && (await cnt('#shrRecList .rc')) === 1, 'карточки: 2 временных и 1 повторяющееся');
        check((await cnt('#shrTmpList .rc:first-child .sw')) === 2, 'у общего две галочки');
        const lab = await page.locator('#shrTmpList .rc:first-child .rw span').allInnerTexts();
        check(lab[0] === 'Вы' && lab[1] === PNAME, 'подписи галочек: ' + JSON.stringify(lab));
        check((await page.locator('#shrRecList .sw').nth(1).getAttribute('aria-checked')) === 'false', 'галочка партнёра у повторяющегося выключена');
        check((await cnt('#tmpList .sw')) === 1, 'у личного одна галочка');
        // отправленное: галочки недоступны, правки нет
        check((await cnt('#shrTmpList [data-t="cccccccccccc"] .sw[disabled]')) === 2 && (await cnt('#shrTmpList [data-t="cccccccccccc"] [data-edit]')) === 0, 'отправленное: галочки недоступны, правки нет');
        check(/Отправлено вам/.test(await page.locator('#shrTmpList [data-t="cccccccccccc"] .rd').innerText()), 'отправленное: «Отправлено вам»');
        await noHScroll('вкладка');

        // ---------- галочки: своя и партнёра ----------
        await arm();
        await page.locator('#shrTmpList [data-t="dddddddddddd"] .sw').nth(1).click();
        await saved();
        let c = lastCall('PUT', 'custom');
        check(JSON.stringify(c.slice(0, 4)) === JSON.stringify(['PUT', 'custom', true, { id: 'dddddddddddd', key: 'on', value: false, shared: true, who: 'partner' }]), 'галочка партнёра: ' + JSON.stringify(c));
        check((await page.locator('#shrTmpList [data-t="dddddddddddd"] .sw').nth(1).getAttribute('aria-checked')) === 'false' && (await page.locator('#shrTmpList [data-t="dddddddddddd"] .sw').nth(0).getAttribute('aria-checked')) === 'true', 'у партнёра выключена, своя включена');
        await arm();
        await page.locator('#shrTmpList [data-t="dddddddddddd"] .sw').nth(0).click();
        await saved();
        c = lastCall('PUT', 'custom');
        check(JSON.stringify(c[3]) === JSON.stringify({ id: 'dddddddddddd', key: 'on', value: false, shared: true, who: 'me' }), 'своя галочка: ' + JSON.stringify(c[3]));
        check((await cnt('#shrTmpList [data-t="dddddddddddd"].off')) === 1, 'обе выключены: карточка серая');
        // личный переключатель без shared
        await arm();
        await page.click('#tmpList .sw');
        await saved();
        c = lastCall('PUT', 'custom');
        check(c[2] === false && JSON.stringify(c[3]) === JSON.stringify({ id: 'aaaaaaaaaaaa', key: 'on', value: false }), 'личный переключатель без shared: ' + JSON.stringify(c));

        // ---------- создание общего временного ----------
        await page.click('#shrTmpAdd');
        check((await cnt('#shrTmpForm:not([hidden])')) === 1 && (await cnt('#tmpForm:not([hidden])')) === 0, 'форма открыта только у общих');
        await pickDay('#shrTmpForm');
        await page.click('#shrTmpForm [data-h="14"]');
        check(/Новое общее напоминание/.test(await page.locator('#shrTmpForm').innerText()) && /Придёт вам и «/.test(await page.locator('#shrTmpForm').innerText()), 'форма: заголовок и подсказка про обоих');
        await noHScroll('форма общего');
        await page.fill('#tText', 'Вместе в кино');
        await save('#shrTmpForm');
        await page.waitForFunction(() => document.querySelectorAll('#shrTmpList .rc').length === 3, null, { timeout: 5000 });
        c = lastCall('POST', 'custom');
        check(c[2] === true && JSON.stringify(c[3]) === JSON.stringify({ date: tomorrow, slot: 'h14', text: 'Вместе в кино', shared: true }), 'POST общего временного: ' + JSON.stringify(c));
        const made = page.locator('#shrTmpList .rc', { hasText: 'Вместе в кино' });
        check((await made.locator('.sw[aria-checked=true]').count()) === 2, 'новое общее: обе галочки включены');
        check((await cnt('#tmpList .rc')) === 1, 'в личные оно не попало');

        // ---------- создание общего повторяющегося ----------
        await page.click('#shrRecAdd');
        await pickDay('#shrRecForm');
        await page.click('#shrRecForm [data-e=week]');
        await page.click('#shrRecForm [data-h="18"]');
        await page.fill('#tText', 'Счётчики');
        await save('#shrRecForm');
        await page.waitForFunction(() => document.querySelectorAll('#shrRecList .rc').length === 2, null, { timeout: 5000 });
        c = lastCall('POST', 'recurring');
        check(c[2] === true && JSON.stringify(c[3]) === JSON.stringify({ date: tomorrow, slot: 'h18', text: 'Счётчики', every: 'week', shared: true }), 'POST общего повторяющегося: ' + JSON.stringify(c));

        // ---------- создание общего повторяющегося по числам месяца ----------
        await page.click('#shrRecAdd');
        await page.click('#shrRecForm [data-by="days"]');
        await page.click('#shrRecForm [data-n="15"]');
        await page.click('#shrRecForm [data-n="1"]');
        check((await cnt('#shrRecForm [data-e]')) === 0 && (await cnt('#shrRecForm [data-h]:disabled')) === 0, 'общее по числам: частоты нет, время не заблокировано');
        await page.click('#shrRecForm [data-h="9"]');
        await page.fill('#tText', 'Квартплата');
        await noHScroll('общая форма по числам месяца');
        await save('#shrRecForm');
        await page.waitForFunction(() => document.querySelectorAll('#shrRecList .rc').length === 3, null, { timeout: 5000 });
        c = lastCall('POST', 'recurring');
        check(c[2] === true && JSON.stringify(c[3]) === JSON.stringify({ days: [1, 15], slot: 'h09', text: 'Квартплата', shared: true }), 'POST общего по числам: ' + JSON.stringify(c));
        check(/1, 15 числа, после 09:00/.test(await page.locator('#shrRecList .rc', { hasText: 'Квартплата' }).innerText()), 'общая карточка: «1, 15 числа, после 09:00»');

        // ---------- правка ----------
        await page.click('#shrTmpList [data-edit="dddddddddddd"]');
        check(/Изменение общего напоминания/.test(await page.locator('#shrTmpForm').innerText()), 'правка: заголовок про общее');
        await arm();
        await page.fill('#tText', 'Торт и свечи');
        await save('#shrTmpForm');
        await saved();
        c = lastCall('PUT', 'custom');
        check(c[2] === true && JSON.stringify(c[3]) === JSON.stringify({ id: 'dddddddddddd', text: 'Торт и свечи', shared: true }), 'PUT правки общего: ' + JSON.stringify(c[3]));
        check((await cnt('#shrTmpList [data-t="dddddddddddd"] .tt')) === 1 && /Торт и свечи/.test(await page.locator('#shrTmpList [data-t="dddddddddddd"] .tt').innerText()), 'правка видна в списке');

        // ---------- удаление: «Уверены?», shared=1 ----------
        await page.click('#shrRecList [data-del="ffffffffffff"]');
        check((await cnt('#shrRecList [data-del="ffffffffffff"].arm')) === 1, 'удаление общего: «Уверены?»');
        await page.click('#shrRecList [data-del="ffffffffffff"]');
        await page.waitForFunction(() => document.querySelectorAll('#shrRecList .rc').length === 2, null, { timeout: 5000 });
        c = lastCall('DELETE', 'recurring');
        check(c[2] === true && /shared=1/.test(c[4]) && c[3] === 'ffffffffffff', 'DELETE общего с shared=1: ' + JSON.stringify(c));
        await noHScroll('после правок');

        // ---------- связь разорвана на другом устройстве: 409 nopair ----------
        state.broken = true;
        await page.locator('#shrTmpList [data-t="dddddddddddd"] .sw').nth(0).click();
        await page.waitForFunction(() => document.getElementById('shrCol').hidden, null, { timeout: 5000 });
        check(/больше не соединены/.test(await page.locator('#remMsg').innerText()), 'после 409: сообщение «аккаунты больше не соединены»');
        check((await page.locator('#remStage .rgrp:not([hidden])').count()) === 1 && (await cnt('#tmpList .rc')) === 1, 'осталась рамка «Личные» с карточками');
        await noHScroll('без общей колонки');

        // ---------- не соединён: shared нет в ответе ----------
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#tmpList .rc', { timeout: 5000 });
        await page.waitForSelector('#mainNav:not([hidden])', { timeout: 5000 }); // нижняя панель на телефоне появляется после проверки сессии: без ожидания она накрывает кнопки внизу экрана посреди клика
        check((await page.locator('#shrCol').isHidden()) && (await page.locator('#remStage .rgrp:not([hidden])').count()) === 1, 'без shared рамки «Общие» нет');
        check(!/Общие/.test(await page.locator('#remStage').evaluate((e) => Array.prototype.filter.call(e.querySelectorAll('*'), (x) => x.offsetParent !== null).map((x) => x.children.length ? '' : x.textContent).join(' '))), 'слова «Общие» на экране нет');
        await noHScroll('не соединён');

        const csp = await page.evaluate(() => window.__csp);
        check(csp.length === 0, 'CSP: ' + csp.join('; '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0] + ' @ ' + (e.stack.match(/smoke-shared.mjs:\d+/) || [''])[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  общие напоминания${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
