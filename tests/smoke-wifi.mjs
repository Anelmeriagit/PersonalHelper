// Сценарий smoke.mjs --only=wifi (общие настройки и заглушки: smoke-lib.mjs, fixtures.mjs).
import { qr } from './fixtures.mjs';
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';

// ---------- сети Wi-Fi: форма, карточки, добавление до 5, правка и удаление по id, печать одной сети ----------

export async function wifi({ stand, browser, fail }) {
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
      const calls = [];
      let nets = [], seq = 0;
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of (400|404)/.test(m.text())) problems.push('console: ' + m.text()); });
      // сервер со списком сетей: add, id, DELETE ?id=, 400 по паролю и лимиту, 404 на чужой id
      const view = () => ({ configured: nets.length > 0, nets: nets.map((n) => ({ ...n, qr })) });
      await page.route((u) => u.pathname === '/api/wifi', (r) => {
        const req = r.request(), m = req.method();
        let status = 200, body;
        if (m === 'GET') body = view();
        else if (m === 'PUT') {
          const b = req.postDataJSON();
          calls.push(['PUT', b]);
          const cfg = { ssid: b.ssid, password: b.security === 'nopass' ? '' : b.password, security: b.security, hidden: !!b.hidden };
          if (b.security !== 'nopass' && b.password.length < 8) { status = 400; body = { error: 'password' }; }
          else if (b.add) {
            if (nets.length >= 5) { status = 400; body = { error: 'limit' }; }
            else { nets.push({ id: 'n' + (++seq) + 'abcdef', ...cfg }); body = view(); }
          } else {
            const i = nets.findIndex((n) => n.id === b.id);
            if (i < 0) { status = 404; body = { error: 'nonet' }; }
            else { nets[i] = { id: b.id, ...cfg }; body = view(); }
          }
        } else {
          const id = new URL(req.url()).searchParams.get('id');
          calls.push([m, id]);
          nets = nets.filter((n) => n.id !== id);
          body = view();
        }
        r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      });
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const text = (sel) => page.locator(sel).first().innerText();
      const cards = page.locator('#wifiBody .wcard');
      const noHScroll = async (where) => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
      };
      const waitCards = (n) => page.waitForFunction((k) => document.querySelectorAll('#wifiBody .wcard').length === k, n, { timeout: 5000 });
      // заполняет открытую форму и отправляет с клавиатуры (кнопка «Сохранить» под сообщением об ошибке на 360 px не ловит щелчок Playwright)
      const fillNet = async (ssid, sec, pw) => {
        await page.waitForSelector('#wForm', { timeout: 5000 });
        await page.fill('#wfSsid', ssid); await page.selectOption('#wfSec', sec);
        if (sec !== 'nopass') await page.fill('#wfPw', pw);
        await page.press('#wfSsid', 'Enter');
      };
      try {
        await page.goto(stand.url + '/#wifi', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector('#wForm', { timeout: 5000 });
        check((await page.locator('#wifiBody .wqr').count()) === 0, 'не настроено: QR нет');
        check(/хранятся только в вашем аккаунте/.test(await text('#wifiBody')), 'не настроено: пояснение про аккаунт');
        check((await page.locator('#wifiBody [data-wf=del]').count()) === 0 && (await page.locator('#wifiBody [data-wf=cancel]').count()) === 0, 'не настроено: кнопок «Удалить» и «Отмена» нет');
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
        await page.press('#wfPw', 'Enter');
        await waitCards(1);
        const put = calls[calls.length - 1][1];
        check(JSON.stringify(put) === JSON.stringify({ ssid: 'HomeNet', security: 'WPA', password: 'secret-pass-1', hidden: true, add: true }), 'запрос сохранения первой сети (add): ' + JSON.stringify(put));
        check((await page.locator('#wifiBody .wcard .wqr .qr').count()) === 1, 'после сохранения нарисован QR');
        check(/QR-код для подключения к сети HomeNet/.test(await page.getAttribute('#wifiBody .wcard .qr', 'aria-label')), 'у QR подпись с названием сети');
        check((await text('.wcard .wpw')).includes('•') && !(await text('#wifiBody')).includes('secret-pass-1'), 'пароль на экране скрыт точками');
        check((await page.locator('#wifiBody .wcard button.weye').count()) === 1 && (await page.locator('#wifiBody .wact [data-wf=show]').count()) === 0, 'вместо кнопки «Показать» значок глаза у пароля');
        check((await page.locator('#wifiBody [data-wf=add]').count()) === 1 && /Сетей: 1 из 5/.test(await text('#wifiBody .wadd')), 'есть «Добавить сеть» и счётчик «1 из 5»');
        check(!(await page.evaluate(() => document.querySelector('#wifiStage .rwrap').classList.contains('wmulti'))), 'одна сеть: рамка обычной ширины');
        const geo = await page.evaluate(() => ({ w: document.querySelector('#wifiBody .wi').getBoundingClientRect().width, p: document.querySelector('.wpw').getBoundingClientRect().right, e: document.querySelector('.weye').getBoundingClientRect().left }));
        check(geo.w <= 320.5, 'строки «Сеть» и «Пароль» не шире QR (320 px): ' + Math.round(geo.w));
        check(geo.e >= geo.p - 1, 'глаз правее скрытого пароля');
        await page.click('.weye');
        check((await text('.wcard .wpw')) === 'secret-pass-1' && (await page.getAttribute('.weye', 'aria-pressed')) === 'true' && /Скрыть/.test(await page.getAttribute('.weye', 'aria-label')), 'глаз показывает пароль, значок и подпись меняются');
        await noHScroll('пароль показан');
        await page.click('.weye');
        check((await text('.wcard .wpw')).includes('•') && (await page.getAttribute('.weye', 'aria-pressed')) === 'false', 'второй щелчок снова скрывает пароль');
        await noHScroll('одна сеть');

        await page.click('[data-wf=edit]');
        check((await page.inputValue('#wfSsid')) === 'HomeNet' && (await page.inputValue('#wfPw')) === 'secret-pass-1' && (await page.isChecked('#wfHid')), 'правка: поля заполнены текущими значениями');
        check((await page.locator('#wifiBody .wfn').count()) === 0, 'правка: пояснения для новой сети нет');
        const before = calls.length;
        await page.click('[data-wf=cancel]');
        check((await cards.count()) === 1 && (await page.locator('#wForm').count()) === 0 && calls.length === before, 'отмена возвращает список без запроса');

        // добавление второй сети: форма новой сети с «Отменой», открытая сеть без пароля
        await page.click('[data-wf=add]');
        await page.waitForSelector('#wForm', { timeout: 3000 });
        check((await page.inputValue('#wfSsid')) === '' && (await page.locator('#wifiBody [data-wf=cancel]').count()) === 1 && (await page.locator('#wifiBody [data-wf=del]').count()) === 0, 'новая сеть: пустая форма, «Отмена» есть, «Удалить» нет');
        await page.click('[data-wf=cancel]');
        check((await cards.count()) === 1, 'отмена новой сети: список как был');
        await page.click('[data-wf=add]');
        await fillNet('Cafe', 'nopass', '');
        await waitCards(2);
        check(JSON.stringify(calls[calls.length - 1][1]) === JSON.stringify({ ssid: 'Cafe', security: 'nopass', password: '', hidden: false, add: true }), 'вторая сеть: add, без пароля: ' + JSON.stringify(calls[calls.length - 1][1]));
        check(await page.evaluate(() => document.querySelector('#wifiStage .rwrap').classList.contains('wmulti')), 'две сети: рамка шире');
        const open = cards.nth(1);
        check((await open.locator('.weye').count()) === 0 && (await open.locator('[data-wf=copy]').count()) === 0 && (await open.locator('.wpp').count()) === 0 && /без пароля/.test(await open.locator('.wpw').innerText()), 'открытая сеть: ни глаза, ни «Копировать пароль», ни галочки листа');
        const pos = await page.evaluate(() => { const a = document.querySelectorAll('#wifiBody .wcard'); const r0 = a[0].getBoundingClientRect(), r1 = a[1].getBoundingClientRect(); return { t0: r0.top, b0: r0.bottom, t1: r1.top, l0: r0.left, l1: r1.left }; });
        if (vp.width >= 700) check(Math.abs(pos.t0 - pos.t1) < 2 && pos.l1 > pos.l0, 'на ширине 1280 карточки рядом: ' + JSON.stringify(pos));
        else check(pos.t1 >= pos.b0 && Math.abs(pos.l0 - pos.l1) < 2, 'на ширине 360 карточки друг под другом: ' + JSON.stringify(pos));
        await noHScroll('две сети');

        // правка второй сети по id и добавление третьей (с паролем): показ пароля относится только к своей карточке
        await cards.nth(1).locator('[data-wf=edit]').click();
        check((await page.inputValue('#wfSsid')) === 'Cafe' && (await page.inputValue('#wfSec')) === 'nopass', 'правка второй: поля её значениями');
        await page.fill('#wfSsid', 'Cafe2');
        await page.press('#wfSsid', 'Enter');
        await page.waitForFunction(() => { const c = document.querySelectorAll('#wifiBody .wcard')[1]; return !!c && /Cafe2/.test(c.innerText); }, null, { timeout: 5000 });
        const pe = calls[calls.length - 1][1];
        check(pe.id === (nets[1] && nets[1].id) && pe.add === undefined && pe.ssid === 'Cafe2', 'правка: PUT с id второй сети, без add: ' + JSON.stringify(pe));
        check(/HomeNet/.test(await cards.nth(0).innerText()) && (await cards.count()) === 2, 'правка второй не тронула первую');
        await page.click('[data-wf=add]');
        await fillNet('Work', 'WPA', 'work-pass-123');
        await waitCards(3);
        await cards.nth(0).locator('.weye').click();
        check((await cards.nth(0).locator('.wpw').innerText()) === 'secret-pass-1' && (await cards.nth(2).locator('.wpw').innerText()).includes('•'), 'глаз первой сети не открывает пароль третьей');
        check(!(await page.locator('#wifiBody').innerText()).includes('work-pass-123'), 'пароль третьей сети в странице скрыт');

        // печать одной сети
        await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
        await cards.nth(2).locator('[data-wf=print]').click();
        const pr = await page.evaluate(() => ({ n: window.__printed, t: document.getElementById('wPrint').innerText }));
        check(pr.n === 1 && /Work/.test(pr.t) && /work-pass-123/.test(pr.t) && !/HomeNet|Cafe2|secret-pass-1/.test(pr.t), 'печать третьей: на листе только её название и пароль: ' + JSON.stringify(pr));
        await cards.nth(0).locator('.wpp').uncheck();
        await cards.nth(0).locator('[data-wf=print]').click();
        const pr2 = await page.evaluate(() => document.getElementById('wPrint').innerText);
        check(/HomeNet/.test(pr2) && !/secret-pass-1|Пароль/.test(pr2) && !/work-pass-123/.test(pr2), 'печать первой без галочки: названия есть, пароля нет: ' + pr2.replace(/\s+/g, ' '));
        check(await cards.nth(2).locator('.wpp').isChecked(), 'галочка листа у третьей осталась включённой');
        await page.emulateMedia({ media: 'print' });
        const pm = await page.evaluate(() => ({ list: getComputedStyle(document.querySelector('.wlist')).display, add: getComputedStyle(document.querySelector('.wadd')).display, pr: getComputedStyle(document.getElementById('wPrint')).display, qrs: document.querySelectorAll('#wPrint .qr').length }));
        check(pm.list === 'none' && pm.add === 'none' && pm.pr === 'block' && pm.qrs === 1, 'печатный вид: карточки скрыты, виден один лист с QR: ' + JSON.stringify(pm));
        await page.emulateMedia({ media: 'screen' });
        check((await page.evaluate(() => getComputedStyle(document.getElementById('wPrint')).display)) === 'none', 'на экране печатный лист скрыт');

        // до пяти сетей и предел
        await page.click('[data-wf=add]'); await fillNet('Net4', 'WPA', 'net4-pass-123'); await waitCards(4);
        await page.click('[data-wf=add]'); await fillNet('Net5', 'WPA', 'net5-pass-123'); await waitCards(5);
        check((await page.locator('#wifiBody [data-wf=add]').count()) === 0 && /предел/.test(await text('#wifiBody .wadd')), 'пять сетей: «Добавить сеть» нет, сказано про предел');
        await noHScroll('пять сетей');

        // удаление по id
        const victim = nets[1].id;
        await cards.nth(1).locator('[data-wf=edit]').click();
        await page.click('[data-wf=del]');
        await page.waitForSelector('#dlg[open]', { timeout: 3000 });
        check(/Cafe2/.test(await text('#dlg')), 'подтверждение удаления называет сеть');
        await page.click('#dlg .done');
        await waitCards(4);
        const dl = calls[calls.length - 1];
        check(dl[0] === 'DELETE' && dl[1] === victim, 'удаление: DELETE ?id= этой сети: ' + JSON.stringify(dl));
        check(!/Cafe2/.test(await page.locator('#wifiBody').innerText()) && (await page.locator('#wifiBody [data-wf=add]').count()) === 1, 'после удаления сети нет, «Добавить сеть» вернулась');

        // сеть удалена с другого устройства: правка даёт 404, список обновляется
        await cards.nth(0).locator('[data-wf=edit]').click();
        nets = nets.slice(1);
        await page.fill('#wfSsid', 'Gone');
        await page.press('#wfSsid', 'Enter');
        await waitCards(3);
        check(!/Gone|HomeNet/.test(await page.locator('#wifiBody').innerText()) && /уже удалена/.test(await text('#wifiMsg')), '404: сообщение и свежий список');

        // удаляем остальные: после последней открывается пустая форма
        for (let i = 3; i > 0; i--) {
          await cards.nth(0).locator('[data-wf=edit]').click();
          await page.click('[data-wf=del]');
          await page.waitForSelector('#dlg[open]', { timeout: 3000 });
          await page.click('#dlg .done');
          if (i > 1) await waitCards(i - 1);
        }
        await page.waitForSelector('#wForm', { timeout: 5000 });
        check((await page.locator('#wifiBody .qr').count()) === 0 && !(await page.locator('#wifiBody').innerHTML()).includes('pass-'), 'после удаления всех сетей QR и пароли пропали из страницы');
        check(!(await page.evaluate(() => document.querySelector('#wifiStage .rwrap').classList.contains('wmulti'))), 'форма: рамка обычной ширины');
        // общий Wi-Fi: окно выбора поверх вкладки Wi-Fi (после соединения по ссылке); после выбора список перечитывается
        let chosen = null, gets = 0;
        const own = { id: 's1abcdef', ssid: 'Mine1', password: 'mine-pass-123', security: 'WPA', hidden: false };
        nets = [own];
        page.on('request', (rq) => { if (rq.method() === 'GET' && new URL(rq.url()).pathname === '/api/wifi') gets++; });
        await page.route('**/api/auth', (r) => {
          const b = r.request().postDataJSON();
          const ok = (body) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
          if (b.action === 'pair-join') return ok({ partner: { linked: true, name: 'Анна К' }, wifi: { choose: true, mine: [{ ssid: 'Mine1', security: 'WPA', hidden: false }], partner: [{ ssid: 'Theirs1', security: 'WPA', hidden: false }], both: 2 } });
          if (b.action === 'pair-wifi') { chosen = b.choice; nets = [own, { id: 's2abcdef', ssid: 'Theirs1', password: 'theirs-pass-123', security: 'WPA', hidden: false }]; return ok({ pending: false }); }
          return r.fallback();
        });
        await page.goto(stand.url + '/?join=AAAAAAAAAAAAAAAAAAAAAA#wifi', { waitUntil: 'load', timeout: 15000 });
        await page.waitForSelector('#dlg[open]', { timeout: 5000 });
        await waitCards(1);
        check(/соединён/.test(await text('#dlgMsg')) && !(await page.locator('#wfDlg').evaluate((d) => d.open)), 'после соединения сначала сообщение, окна выбора ещё нет');
        await page.click('#dlg .done');
        await page.waitForSelector('#wfDlg[open]', { timeout: 5000 });
        check((await cards.count()) === 1 && chosen === null, 'пока окно открыто, у страницы свой список из одной сети');
        const g0 = gets;
        await page.click('#wfDlg [data-wd=both]');
        await waitCards(2);
        check(chosen === 'both' && gets === g0 + 1, 'выбор «обе»: pair-wifi и повторное чтение списка: ' + chosen + ' ' + (gets - g0));
        check(!(await page.locator('#wfDlg').evaluate((d) => d.open)) && /Theirs1/.test(await page.locator('#wifiBody').innerText()), 'после выбора окно закрыто, сеть партнёра в списке');
        await noHScroll('после выбора сетей');
        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  wifi: сети${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
