// Сценарий smoke.mjs --only=rem (общие настройки и заглушки: smoke-lib.mjs, fixtures.mjs).
import { mskDay } from './fixtures.mjs';
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';

// ---------- «Напоминания»: две колонки, без «Кому», создание, переключатель, удаление ----------

export async function rem({ stand, browser, fail }) {
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
      const tomorrow = mskDay(1);
      const state = {
        custom: [{ id: 'aaaaaaaaaaaa', date: mskDay(3), slot: 'day', text: 'Позвонить <b>маме</b>', on: true, sent: false }],
        recurring: [{ id: 'bbbbbbbbbbbb', date: mskDay(2), every: 'week', slot: 'evening', text: 'Полить цветы', on: true, next: mskDay(2) }],
      };
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
      const view = () => JSON.stringify({ linked: true, custom: state.custom, recurring: state.recurring });
      await page.route('**/api/reminders', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: view() }));
      for (const [kind, list] of [['custom', 'custom'], ['recurring', 'recurring']]) {
        await page.route('**/api/' + kind + '*', (r) => {
          const req = r.request(), m = req.method(), u = new URL(req.url());
          const body = m === 'DELETE' ? null : req.postDataJSON();
          calls.push([m, kind, body || u.searchParams.get('id')]);
          if (m === 'POST') state[list].push({ id: String(state[list].length + 1).padStart(12, 'c'), on: true, ...(kind === 'custom' ? { sent: false } : { next: body.date }), ...body });
          else if (m === 'PUT') { const it = state[list].find((x) => x.id === body.id); if (it && body.key === 'on') it.on = body.value; }
          else state[list] = state[list].filter((x) => x.id !== u.searchParams.get('id'));
          r.fulfill({ status: 200, contentType: 'application/json', body: view() });
        });
      }
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const noHScroll = async (where) => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
      };
      // Сохранить: форма с сеткой времени длиннее экрана, поэтому кнопку ставим в середину экрана (внизу её накрывает нижняя панель), фокус из поля текста снимаем
      const save = async (formSel) => {
        await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
        await page.locator(formSel + ' [data-f=save]').evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await page.click(formSel + ' [data-f=save]');
      };
      const pickDay = async (formSel) => {
        if ((await page.locator(`${formSel} [data-d="${tomorrow}"]`).count()) === 0) await page.click(`${formSel} [data-nav="1"]`);
        await page.click(`${formSel} [data-d="${tomorrow}"]`);
      };
      try {
        await page.goto(stand.url + '/#reminders', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector('#tmpList .rc', { timeout: 5000 });
        await page.waitForSelector('#mainNav:not([hidden])', { timeout: 5000 }); // нижняя панель на телефоне появляется после проверки сессии: без ожидания она накрывает кнопки внизу экрана посреди клика
        await page.waitForSelector('#recList .rc', { timeout: 5000 });
        // разметка
        check((await page.locator('#remStage .rgrp:not([hidden]) .rcol').count()) === 2 && (await page.locator('#remStage .rgrp:not([hidden])').count()) === 1, 'одна рамка «Личные» с двумя колонками (рамка «Общие» без связи скрыта)');
        check((await page.locator('#remBody').count()) === 0 && !/Постоянные/.test(await page.locator('#remStage').innerText()), 'колонки «Постоянные» нет');
        check(!/Кому|Денис|Жанна/.test(await page.locator('#remStage').innerText()), 'на вкладке нет «Кому», Дениса и Жанны');
        check((await page.locator('#remStage input[type=checkbox]').count()) === 0, 'галок получателей нет');
        const xs = await page.locator('#remStage .rgrp:not([hidden]) .rcol').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
        if (vp.width >= 900) check(xs[0] !== xs[1], 'на 1280 px колонки рядом');
        else check(xs[0] === xs[1], 'на 360 px колонки друг под другом');
        check((await page.locator('#tmpList .tt b').count()) === 0 && /<b>маме<\/b>/.test(await page.locator('#tmpList .tt').innerText()), 'текст напоминания экранирован');
        await noHScroll('вкладка');

        check(/после 14:00/.test(await page.locator('#tmpList').innerText()), 'старый слот day показан как «после 14:00»');
        check(/после 18:00/.test(await page.locator('#recList').innerText()), 'старый слот evening показан как «после 18:00»');

        // переключатель: PUT только {id, key:'on', value}
        await page.click('#tmpList .sw');
        await page.waitForFunction(() => /Сохранено/.test(document.getElementById('remMsg').textContent), null, { timeout: 5000 });
        check(JSON.stringify(calls[calls.length - 1]) === JSON.stringify(['PUT', 'custom', { id: 'aaaaaaaaaaaa', key: 'on', value: false }]), 'переключатель: тело PUT ' + JSON.stringify(calls[calls.length - 1]));
        check((await page.locator('#tmpList .rc.off').count()) === 1, 'выключенная карточка серая');

        // создание временного
        await page.click('#tmpAdd');
        await pickDay('#tmpForm');
        check((await page.locator('#tmpForm [data-h]').count()) === 17 && (await page.locator('#tmpForm [data-m]').count()) === 2, 'сетка времени: 17 часов и минуты 00 и 30');
        check((await page.locator('#tmpForm [data-h]').first().innerText()) === '07' && (await page.locator('#tmpForm [data-h]').last().innerText()) === '23', 'сетка времени: часы от 07 до 23');
        await page.click('#tmpForm [data-h="14"]');
        await save('#tmpForm');
        check(/Напишите текст/.test(await page.locator('#fmErr').innerText()), 'пустой текст: сообщение');
        check(!calls.some((c) => c[0] === 'POST'), 'пустой текст: запроса нет');
        await page.fill('#tText', 'Купить хлеб');
        await noHScroll('форма временного');
        await save('#tmpForm');
        await page.waitForFunction(() => document.querySelectorAll('#tmpList .rc').length === 2, null, { timeout: 5000 });
        const pc = calls.filter((c) => c[0] === 'POST' && c[1] === 'custom')[0];
        check(JSON.stringify(pc && pc[2]) === JSON.stringify({ date: tomorrow, slot: 'h14', text: 'Купить хлеб' }), 'POST /api/custom без who: ' + JSON.stringify(pc && pc[2]));

        // создание повторяющегося
        await page.click('#recAdd');
        await pickDay('#recForm');
        await page.click('#recForm [data-e=week]');
        await page.click('#recForm [data-h="18"]');
        await page.click('#recForm [data-m="30"]');
        await page.fill('#tText', 'Счётчики');
        await noHScroll('форма повторяющегося');
        await save('#recForm');
        await page.waitForFunction(() => document.querySelectorAll('#recList .rc').length === 2, null, { timeout: 5000 });
        const pr = calls.filter((c) => c[0] === 'POST' && c[1] === 'recurring')[0];
        check(JSON.stringify(pr && pr[2]) === JSON.stringify({ date: tomorrow, slot: 'h18m30', text: 'Счётчики', every: 'week' }), 'POST /api/recurring без who: ' + JSON.stringify(pr && pr[2]));

        // удаление с подтверждением «Уверены?»
        await page.click('#recList [data-del="bbbbbbbbbbbb"]');
        check((await page.locator('#recList [data-del="bbbbbbbbbbbb"].arm').count()) === 1, 'удаление: «Уверены?»');
        await page.click('#recList [data-del="bbbbbbbbbbbb"]');
        await page.waitForFunction(() => document.querySelectorAll('#recList .rc').length === 1, null, { timeout: 5000 });
        const dl = calls[calls.length - 1];
        check(dl[0] === 'DELETE' && dl[1] === 'recurring' && dl[2] === 'bbbbbbbbbbbb', 'DELETE /api/recurring?id=: ' + JSON.stringify(dl));
        await noHScroll('после удаления');
        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  напоминания: две колонки${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
