// Дымовая проверка интерфейса в Chromium (Playwright) с CSP из vercel.json и мок-API.
// Для каждой страницы × ширины 360/1280 × светлой/тёмной темы проверяет:
//   нет нарушений CSP, нет ошибок JS и console.error, нет обращений к незамоканному API,
//   нет горизонтальной прокрутки.
// Экран входа и регистрации (--only=auth), кэшбэк для одного человека (--only=cashback) и личная сеть WiFi (--only=wifi) проверяются отдельными сценариями.
// Запуск: node tests/smoke.mjs [--root=<папка>] [--only=auth|cashback|wifi]   (Playwright: npm i --no-save playwright && npx playwright install chromium)
import path from 'node:path';
import { chromium } from 'playwright';
import { start } from './serve.mjs';
import { qr } from './fixtures.mjs';

const arg = process.argv.find((a) => a.startsWith('--root='));
const root = arg ? path.resolve(arg.slice(7)) : undefined;

const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const run = (name) => !ONLY || ONLY === name;
const PAGES = ONLY ? [] : [['главная', ''], ['напоминания', '#reminders'], ['wifi', '#wifi'], ['агент', '#agent']];
const VIEWPORTS = [{ width: 360, height: 800 }, { width: 1280, height: 800 }];
const SCHEMES = ['light', 'dark'];

const stand = await start({ root });
console.log('CSP: ' + (stand.csp || 'НЕ НАЙДЕНА в vercel.json: проверка CSP не имеет смысла'));
const browser = await chromium.launch();
let failures = 0;

for (const scheme of SCHEMES) {
  for (const vp of VIEWPORTS) {
    for (const [name, hash] of PAGES) {
      const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
      // Тема в приложении хранится в localStorage (ключ theme); значение подбираем по схеме.
      await ctx.addInitScript((s) => {
        try { localStorage.setItem('theme', s); } catch { /* нет доступа */ }
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
      if (problems.length) failures++;
      await ctx.close();
    }
  }
}

// ---------- экран входа и регистрации ----------
for (const scheme of run('auth') ? SCHEMES : []) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
    await ctx.addInitScript((s) => {
      try { localStorage.setItem('theme', s); } catch { /* нет доступа */ }
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    }, scheme);
    const page = await ctx.newPage();
    const problems = [];
    const posts = [];
    page.on('pageerror', (e) => problems.push('JS: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[19]|status of 409/.test(m.text())) problems.push('console: ' + m.text()); });
    await page.route('**/api/data', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"auth"}' }));
    await page.route('**/api/auth', (r) => {
      posts.push(r.request().postDataJSON());
      r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Этот никнейм уже занят' }) });
    });
    const check = (cond, msg) => { if (!cond) problems.push(msg); };
    const text = (sel) => page.locator(sel).first().innerText();
    const noHScroll = async (where) => {
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
    };
    const submit = () => page.locator('#lf .done').click();
    try {
      await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
      await page.waitForSelector('#lf', { timeout: 5000 });
      check((await text('#lf h2')) === 'Вход', 'вход: заголовок');
      check(!(await page.locator('#mainNav').isVisible()), 'вход: навигация скрыта');
      check(await page.locator('#themeBtn').isVisible(), 'вход: переключатель темы виден');
      check(!(await page.locator('#outBtn').isVisible()) && !(await page.locator('#editBtn').isVisible()), 'вход: кнопки выхода и правки скрыты');
      check((await page.locator('#pw2').count()) === 0, 'вход: нет поля повтора пароля');
      await noHScroll('вход');

      await page.click('#am');
      check((await text('#lf h2')) === 'Регистрация', 'регистрация: заголовок');
      check((await page.locator('#pw2').count()) === 1, 'регистрация: есть поле повтора пароля');
      check((await page.locator('#lf .hint').count()) === 2, 'регистрация: две подсказки');
      const h = await page.locator('#am').evaluate((el) => el.getBoundingClientRect().height);
      check(h >= 32, 'переключатель режима слишком мелкий: ' + Math.round(h) + ' px');
      await noHScroll('регистрация');

      await page.fill('#u', 'ab'); await page.fill('#pw', 'password1'); await page.fill('#pw2', 'password1'); await submit();
      check(/3–24/.test(await text('#le')), 'короткий никнейм: сообщение «' + (await text('#le')) + '»');
      await page.fill('#u', 'anna_k'); await page.fill('#pw', 'short'); await page.fill('#pw2', 'short'); await submit();
      check(/не короче 8/.test(await text('#le')), 'короткий пароль: сообщение');
      await page.fill('#pw', 'password1'); await page.fill('#pw2', 'password2'); await submit();
      check((await text('#le')) === 'Пароли не совпадают', 'разные пароли: сообщение');
      check(posts.length === 0, 'до успешной проверки на клиенте запросов быть не должно');

      await page.fill('#u', '  Anna_K '); await page.fill('#pw2', 'password1'); await submit();
      await page.waitForFunction(() => document.getElementById('le').textContent.length > 0 && !document.querySelector('#lf .done').disabled, null, { timeout: 5000 });
      check((await text('#le')) === 'Этот никнейм уже занят', 'ошибка сервера показана');
      check(posts.length === 1 && JSON.stringify(posts[0]) === JSON.stringify({ action: 'register', user: 'Anna_K', pass: 'password1' }), 'запрос регистрации: ' + JSON.stringify(posts[0]));

      await page.click('#am');
      check((await text('#lf h2')) === 'Вход', 'возврат ко входу');
      check((await page.inputValue('#u')) === 'Anna_K', 'никнейм сохраняется при переключении');
      await page.fill('#pw', 'password1'); await submit();
      await page.waitForFunction(() => document.getElementById('le').textContent.length > 0, null, { timeout: 5000 });
      check(posts.length === 2 && posts[1].action === 'login', 'запрос входа');
      await noHScroll('вход после ошибки');
      const csp = await page.evaluate(() => window.__csp);
      check(!csp.length, 'CSP: ' + csp.join('; '));
    } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  вход/регистрация${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
    if (problems.length) failures++;
    await ctx.close();
  }
}

// ---------- кэшбэк для одного человека ----------
for (const scheme of run('cashback') ? SCHEMES : []) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
    await ctx.addInitScript((s) => {
      try { localStorage.setItem('theme', s); localStorage.removeItem('view'); } catch { /* нет доступа */ }
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
    if (problems.length) failures++;
    await ctx.close();
  }
}

// ---------- личная сеть WiFi: форма, сохранение, правка, удаление ----------
for (const scheme of run('wifi') ? SCHEMES : []) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
    await ctx.addInitScript((s) => {
      try { localStorage.setItem('theme', s); } catch { /* нет доступа */ }
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    }, scheme);
    const page = await ctx.newPage();
    const problems = [];
    const calls = [];
    let net = null;
    page.on('pageerror', (e) => problems.push('JS: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 400/.test(m.text())) problems.push('console: ' + m.text()); });
    await page.route('**/api/wifi', (r) => {
      const req = r.request(), m = req.method();
      let status = 200, body;
      if (m === 'GET') body = net ? { configured: true, ...net, qr } : { configured: false };
      else if (m === 'PUT') {
        const b = req.postDataJSON();
        calls.push(['PUT', b]);
        if (b.security !== 'nopass' && b.password.length < 8) { status = 400; body = { error: 'password' }; }
        else { net = { ssid: b.ssid, password: b.password, security: b.security, hidden: b.hidden }; body = { configured: true, ...net, qr }; }
      } else { calls.push([m]); net = null; body = { configured: false }; }
      r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const check = (cond, msg) => { if (!cond) problems.push(msg); };
    const text = (sel) => page.locator(sel).first().innerText();
    const noHScroll = async (where) => {
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
    };
    try {
      await page.goto(stand.url + '/#wifi', { waitUntil: 'load', timeout: 15000 });
      await page.waitForSelector('#wForm', { timeout: 5000 });
      check((await page.locator('#wifiBody .wqr').count()) === 0, 'не настроено: QR нет');
      check(/хранятся только в вашем аккаунте/.test(await text('#wifiBody')), 'не настроено: пояснение про аккаунт');
      check((await page.locator('#wifiBody [data-wf=del]').count()) === 0, 'не настроено: кнопки «Удалить» нет');
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
      await page.click('#wForm .done');
      await page.waitForSelector('#wifiBody .wqr', { timeout: 5000 });
      const put = calls[calls.length - 1][1];
      check(JSON.stringify(put) === JSON.stringify({ ssid: 'HomeNet', security: 'WPA', password: 'secret-pass-1', hidden: true }), 'запрос сохранения: ' + JSON.stringify(put));
      check((await page.locator('#wifiBody .wqr .qr').count()) === 1, 'после сохранения нарисован QR');
      check((await text('#wPw')).includes('•') && !(await text('#wifiBody')).includes('secret-pass-1'), 'пароль на экране скрыт точками');
      check((await page.locator('#wifiBody [data-wf=edit]').count()) === 1, 'есть кнопка «Изменить сеть»');
      await noHScroll('сеть настроена');

      await page.click('[data-wf=edit]');
      check((await page.inputValue('#wfSsid')) === 'HomeNet' && (await page.inputValue('#wfPw')) === 'secret-pass-1' && (await page.isChecked('#wfHid')), 'правка: поля заполнены текущими значениями');
      await page.click('[data-wf=cancel]');
      check((await page.locator('#wifiBody .wqr').count()) === 1 && (await page.locator('#wForm').count()) === 0, 'отмена возвращает экран с QR без запроса');

      await page.click('[data-wf=edit]');
      await page.click('[data-wf=del]');
      await page.waitForSelector('#dlg[open]', { timeout: 3000 });
      await page.click('#dlg .done');
      await page.waitForSelector('#wifiBody [data-wf=del]', { state: 'detached', timeout: 5000 });
      await page.waitForSelector('#wForm', { timeout: 5000 });
      check(calls[calls.length - 1][0] === 'DELETE', 'удаление: был DELETE');
      check((await page.locator('#wifiBody .qr').count()) === 0 && !(await page.locator('#wifiBody').innerHTML()).includes('secret-pass-1'), 'после удаления QR и пароль пропали из страницы');
      const csp = await page.evaluate(() => window.__csp);
      check(!csp.length, 'CSP: ' + csp.join('; '));
    } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  wifi: личная сеть${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
    if (problems.length) failures++;
    await ctx.close();
  }
}

await browser.close();
await stand.close();
console.log(failures ? `\nПровалено случаев: ${failures}` : '\nВсе случаи без замечаний');
process.exit(failures ? 1 : 0);
