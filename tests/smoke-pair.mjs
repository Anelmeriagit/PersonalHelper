// Сценарий smoke.mjs --only=pair: «Соединить аккаунты» (часть 2): кнопка «Поделиться» (буфер на компьютере, меню на телефоне),
// соединённый аккаунт и «Разорвать», открытие ссылки /?join=<токен> (аккаунт, гость, ошибки). Общее: smoke-lib.mjs, fixtures.mjs.
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';

const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAA';
const TOKEN2 = 'BBBBBBBBBBBBBBBBBBBBBB';

export async function pair({ stand, browser, fail }) {
  for (const scheme of SCHEMES) {
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
      try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: stand.url }); } catch { /* без разрешений проверка буфера пропустится сама */ }
      await ctx.addInitScript((s) => {
        try { localStorage.setItem('theme', s); localStorage.setItem('welcome', '1'); } catch { /* нет доступа */ }
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
        // телефон: основной указатель — палец и есть navigator.share; режим ответа меню задаёт тест
        window.__coarse = false; window.__shared = []; window.__shareMode = 'ok';
        const mm = window.matchMedia.bind(window);
        window.matchMedia = (q) => (/pointer:\s*coarse/.test(q) ? { matches: window.__coarse === true, media: q, addEventListener() {}, removeEventListener() {} } : mm(q));
        navigator.share = (d) => {
          window.__shared.push(d);
          const m = window.__shareMode;
          if (m === 'abort') return Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' }));
          if (m === 'deny') return Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
          return Promise.resolve();
        };
      }, scheme);
      const page = await ctx.newPage();
      const problems = [];
      const posts = [];
      let partner = { linked: false }, linkRes = null, joinRes = null, joinAbort = false, guest = false;
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of (400|401|404|409|429|500)/.test(m.text()) && !/ERR_FAILED/.test(m.text())) problems.push('console: ' + m.text()); });
      const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      await page.route('**/api/data', (r) => (guest ? json(r, { error: 'auth' }, 401) : r.fallback()));
      await page.route('**/api/auth', (r) => {
        const b = r.request().postDataJSON(); posts.push(b);
        if (b.action === 'me') return json(r, { id: '0123456789abcdef0123456789abcdef', name: '', email: '', tg: { linked: false }, partner });
        if (b.action === 'pair-link') return linkRes ? json(r, linkRes.body, linkRes.status) : json(r, { token: TOKEN, ttl: 86400 });
        if (b.action === 'pair-join') {
          if (joinAbort) return r.abort('failed');
          return joinRes ? json(r, joinRes.body, joinRes.status) : json(r, { partner: { linked: true, name: 'Анна К' } });
        }
        if (b.action === 'pair-drop') { partner = { linked: false }; return json(r, { partner }); }
        return json(r, { ok: true });
      });
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const count = (a) => posts.filter((b) => b.action === a).length;
      const text = (sel) => page.locator(sel).first().innerText();
      const vis = (sel) => page.locator(sel).first().isVisible();
      const noHScroll = async (where) => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, dw: document.getElementById('acctDlg').scrollWidth, dc: document.getElementById('acctDlg').clientWidth }));
        check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
        check(!(await page.locator('#acctDlg').evaluate((el) => el.open)) || r.dw <= r.dc, `${where}: в окне настроек горизонтальная прокрутка ${r.dw} > ${r.dc}`);
      };
      const home = async (path = '/') => { await page.goto(stand.url + path, { waitUntil: 'load', timeout: 15000 }); await page.waitForFunction(() => !document.getElementById('uWrap').hidden || !document.getElementById('gBtn').hidden, null, { timeout: 5000 }); };
      const openSettings = async () => {
        await page.click('#uBtn'); await page.click('#uMenu [data-u=settings]');
        await page.waitForFunction(() => document.querySelector('#acctDlg .ar'), null, { timeout: 5000 });
      };
      const closeSettings = async () => { await page.click('#acctDlg [data-a=close]'); };
      const clipboard = () => page.evaluate(() => navigator.clipboard.readText().catch(() => null));
      const dlgText = async () => { await page.waitForSelector('#dlg[open]', { timeout: 5000 }); return text('#dlgMsg'); };
      const dlgOk = async () => { await page.click('#dlg .done'); };
      const URL_OF = (t) => stand.url + '/?join=' + t;
      try {
        // ---------- настройки: не соединён ----------
        await home();
        await openSettings();
        check((await text('#acctDlg')).includes('Соединить аккаунты') && (await page.locator('#acctDlg [data-a=share]').count()) === 1, 'есть кнопка «Поделиться»');
        check((await text('#acctDlg [data-a=share]')) === 'Поделиться', 'подпись кнопки');
        check(/одноразовая и действует 24 часа/.test(await text('#pOk')), 'подсказка про одноразовую ссылку');
        const sb = await page.locator('#acctDlg [data-a=share]').boundingBox();
        check(sb && sb.height >= 44, 'кнопка «Поделиться»: высота ≥ 44 px');
        await noHScroll('настройки, не соединён');

        // ---------- компьютер: ссылка в буфер, повтор берёт ту же ссылку ----------
        await page.click('#acctDlg [data-a=share]');
        await page.waitForFunction(() => /скопирована/.test(document.getElementById('pOk').textContent), null, { timeout: 5000 });
        check(count('pair-link') === 1, 'запрос pair-link один');
        const cb1 = await clipboard();
        if (cb1 !== null) check(cb1 === stand.url + '/?join=' + TOKEN, 'в буфере ссылка с токеном: ' + cb1);
        check(!/\b0123456789abcdef0123456789abcdef\b/.test(String(cb1)), 'id аккаунта в ссылке нет');
        check(await page.evaluate(() => window.__shared.length === 0), 'на компьютере меню «Поделиться» не открывается');
        await page.click('#acctDlg [data-a=share]');
        await page.waitForFunction(() => /скопирована/.test(document.getElementById('pOk').textContent), null, { timeout: 5000 });
        check(count('pair-link') === 1, 'повторное нажатие не создаёт новую ссылку (прежняя гасла бы)');
        check((await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-a'))) === 'share', 'фокус остался на кнопке');
        await noHScroll('ссылка скопирована');

        // ---------- буфер недоступен: ссылка в поле для ручного копирования ----------
        await closeSettings(); await openSettings();
        await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('no')) } }); });
        await page.click('#acctDlg [data-a=share]');
        await page.waitForSelector('#pLink', { timeout: 5000 });
        check((await page.inputValue('#pLink')) === stand.url + '/?join=' + TOKEN, 'ручное копирование: ссылка в поле');
        check(/Скопируйте ссылку/.test(await text('#pOk')), 'ручное копирование: подсказка');
        const lb = await page.locator('#pLink').boundingBox(), db = await page.locator('#acctDlg').boundingBox();
        check(lb && db && lb.x >= db.x && lb.x + lb.width <= db.x + db.width + 1, 'поле ссылки внутри окна');
        await noHScroll('ручное копирование');
        await closeSettings();

        // ---------- телефон: меню navigator.share ----------
        await page.evaluate(() => { window.__coarse = true; });
        await openSettings();
        const before = count('pair-link');
        await page.click('#acctDlg [data-a=share]');
        await page.waitForFunction(() => window.__shared.length === 1, null, { timeout: 5000 });
        const sh = await page.evaluate(() => window.__shared[0]);
        check(sh.url === stand.url + '/?join=' + TOKEN && /Personal Helper/.test(sh.title || ''), 'в меню «Поделиться» ссылка и название: ' + JSON.stringify(sh));
        await page.waitForFunction(() => /отправлена/.test(document.getElementById('pOk').textContent), null, { timeout: 5000 });
        check(count('pair-link') === before + 1, 'телефон: ещё одна ссылка при новом открытии окна');
        // отмена меню: без ошибки и сообщения об успехе
        await page.evaluate(() => { window.__shareMode = 'abort'; });
        await page.click('#acctDlg [data-a=share]');
        await page.waitForFunction(() => window.__shared.length === 2, null, { timeout: 5000 });
        check(!/отправлена|скопирована/.test(await text('#pOk')) && (await text('#pErr')) === '', 'отмена меню: без сообщений об ошибке');
        check(count('pair-link') === before + 1, 'после отмены та же ссылка');
        // меню запрещено системой: запасной путь — буфер
        await page.evaluate(() => { window.__shareMode = 'deny'; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } }); });
        await page.click('#acctDlg [data-a=share]');
        await page.waitForFunction(() => /скопирована/.test(document.getElementById('pOk').textContent), null, { timeout: 5000 });
        await closeSettings();
        await page.evaluate(() => { window.__coarse = false; window.__shareMode = 'ok'; });

        // ---------- ошибки создания ссылки ----------
        linkRes = { status: 429, body: { error: 'Слишком часто. Подождите несколько минут.' } };
        await openSettings();
        await page.click('#acctDlg [data-a=share]');
        await page.waitForFunction(() => /Слишком часто/.test(document.getElementById('pErr').textContent), null, { timeout: 5000 });
        check((await page.locator('#pLink').count()) === 0, 'при ошибке поля ссылки нет');
        await closeSettings();
        // у аккаунта уже есть связь (другое устройство): окно перечитывается и показывает «Разорвать»
        linkRes = { status: 409, body: { error: 'Аккаунт уже соединён. Сначала разорвите связь.', code: 'paired' } };
        await openSettings();
        partner = { linked: true, name: 'Борис' };
        await page.click('#acctDlg [data-a=share]');
        await page.waitForSelector('#acctDlg [data-a=pdrop]', { timeout: 5000 });
        linkRes = null;
        await closeSettings();

        // ---------- соединён: имя партнёра, «Разорвать» ----------
        partner = { linked: true, name: '<i>Борис</i> ' + 'Ж'.repeat(30) };
        await openSettings();
        const t1 = await text('#acctDlg');
        check(t1.includes('<i>Борис</i>') && /аккаунт соединён/.test(t1), 'имя партнёра показано текстом');
        check((await page.locator('#acctDlg i').count()) === 0, 'имя партнёра не создаёт разметку (экранирование)');
        check((await page.locator('#acctDlg [data-a=share]').count()) === 0 && (await page.locator('#acctDlg [data-a=pdrop]').count()) === 1, 'вместо «Поделиться» кнопка «Разорвать»');
        await noHScroll('соединён, длинное имя');
        await page.click('#acctDlg [data-a=pdrop]');
        check(/Разорвать связь с аккаунтом «<i>Борис<\/i>/.test(await dlgText()), 'подтверждение называет партнёра');
        check(/Общие напоминания будут удалены у обоих; личные останутся/.test(await dlgText()), 'подтверждение предупреждает про общие напоминания');
        await page.click('#dlgNo');
        check(count('pair-drop') === 0 && (await page.locator('#acctDlg [data-a=pdrop]').count()) === 1, 'отмена не разрывает связь');
        await page.click('#acctDlg [data-a=pdrop]');
        await page.waitForSelector('#dlg[open]', { timeout: 5000 });
        await page.click('#dlg .done');
        await page.waitForSelector('#acctDlg [data-a=share]', { timeout: 5000 });
        check(count('pair-drop') === 1, 'pair-drop отправлен один раз');
        check((await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-a'))) === 'share', 'после разрыва фокус на «Поделиться»');
        await closeSettings();
        partner = { linked: true, name: '' };
        await openSettings();
        check((await text('#acctDlg .ar:nth-of-type(5) .vn')).startsWith('Helper User'), 'пустое имя партнёра: «Helper User»');
        await closeSettings();
        partner = { linked: false };

        // ---------- открытие ссылки: аккаунт ----------
        const n0 = count('pair-join');
        await home('/?x=1&join=' + TOKEN + '#wifi');
        check(/Ваш аккаунт соединён с аккаунтом Анна К\./.test(await dlgText()), 'сообщение после соединения');
        await dlgOk();
        check(count('pair-join') === n0 + 1 && posts.filter((b) => b.action === 'pair-join').pop().token === TOKEN, 'pair-join с токеном из ссылки');
        check(/\?x=1$|\?x=1#/.test(page.url().replace(stand.url, '')) && /#wifi$/.test(page.url()) && !/join/.test(page.url()), 'из адреса убран join, остальное на месте: ' + page.url());
        check((await page.evaluate(() => localStorage.getItem('pj'))) === null, 'токен не хранится после соединения');
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => !document.getElementById('uWrap').hidden, null, { timeout: 5000 });
        check(count('pair-join') === n0 + 1, 'после перезагрузки повторного соединения нет');

        // пустое имя и имя с разметкой
        joinRes = { status: 200, body: { partner: { linked: true, name: '' } } };
        await home('/?join=' + TOKEN);
        check(/аккаунтом Helper User\./.test(await dlgText()), 'пустое имя давшего ссылку: «Helper User»');
        await dlgOk();
        joinRes = { status: 200, body: { partner: { linked: true, name: '<b>x</b>' } } };
        await home('/?join=' + TOKEN);
        check(/аккаунтом <b>x<\/b>\./.test(await dlgText()) && (await page.locator('#dlgMsg b').count()) === 0, 'имя с разметкой выводится текстом');
        await dlgOk();

        // ошибки сервера: текст с сервера, токен не хранится
        for (const [status, code, msg] of [[400, 'self', 'Нельзя соединить аккаунт с самим собой.'], [404, 'bad', 'Ссылка недействительна или устарела. Попросите новую.'], [409, 'mine', 'Ваш аккаунт уже соединён с другим. Сначала разорвите связь в настройках.'], [409, 'busy', 'Аккаунт, давший ссылку, уже соединён с другим.']]) {
          joinRes = { status, body: { error: msg, code } };
          await home('/?join=' + TOKEN);
          check((await dlgText()) === msg, 'ошибка ' + code + ': ' + msg);
          await dlgOk();
          check((await page.evaluate(() => localStorage.getItem('pj'))) === null, 'после ошибки ' + code + ' токена нет');
        }
        joinRes = { status: 500, body: {} };
        await home('/?join=' + TOKEN);
        check(/Не удалось соединить/.test(await dlgText()), 'сбой без текста: общее сообщение');
        await dlgOk();

        // мусор вместо токена: запрос не уходит, адрес чистый
        joinRes = null;
        const n1 = count('pair-join');
        for (const bad of ['abc', TOKEN + 'A', '%3Cb%3E', '']) {
          await home('/?join=' + bad);
          check(!/join/.test(page.url()), 'мусорный join убран из адреса: ' + bad);
        }
        check(count('pair-join') === n1 && !(await vis('#dlg[open]')), 'мусорные токены: запросов и окон нет');

        // нет связи: токен остаётся, сообщение просит открыть ссылку ещё раз
        joinAbort = true;
        await home('/?join=' + TOKEN2);
        check(/Нет связи с сервером/.test(await dlgText()), 'нет сети: сообщение');
        await dlgOk();
        check((await page.evaluate(() => JSON.parse(localStorage.getItem('pj')).t)) === TOKEN2, 'нет сети: токен сохранён');
        joinAbort = false;
        await home('/');
        check(/соединён с аккаунтом/.test(await dlgText()), 'после возврата связи токен применяется сам');
        await dlgOk();
        check((await page.evaluate(() => localStorage.getItem('pj'))) === null, 'токен потрачен');

        // старый токен (больше суток) игнорируется
        await page.evaluate(() => localStorage.setItem('pj', JSON.stringify({ t: 'CCCCCCCCCCCCCCCCCCCCCC', at: Date.now() - 25 * 3600 * 1000 })));
        const n2 = count('pair-join');
        await home('/');
        check(count('pair-join') === n2 && (await page.evaluate(() => localStorage.getItem('pj'))) === null, 'устаревший токен не отправляется и убирается');

        // ---------- открытие ссылки: гость ----------
        guest = true;
        const n3 = count('pair-join');
        await home('/?join=' + TOKEN);
        check(/войдите через Google/.test(await dlgText()), 'гость: просьба войти');
        await dlgOk();
        check(count('pair-join') === n3, 'гость: запрос соединения не уходит');
        check(!/join/.test(page.url()), 'гость: адрес очищен');
        check((await page.evaluate(() => JSON.parse(localStorage.getItem('pj')).t)) === TOKEN, 'гость: токен сохранён до входа');
        // вход через Google (возврат на сайт уже с сессией): соединение само
        guest = false;
        await home('/');
        check(/Ваш аккаунт соединён с аккаунтом Анна К\./.test(await dlgText()), 'после входа аккаунты соединяются сами');
        await dlgOk();
        check(count('pair-join') === n3 + 1, 'после входа один pair-join');
        await noHScroll('после соединения');

        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  соединить аккаунты${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
