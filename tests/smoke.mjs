// Дымовая проверка интерфейса в Chromium (Playwright) с CSP из vercel.json и мок-API.
// Для каждой страницы × ширины 360/1280 × светлой/тёмной темы проверяет:
//   нет нарушений CSP, нет ошибок JS и console.error, нет обращений к незамоканному API,
//   нет горизонтальной прокрутки.
// Экран входа и регистрации проверяется отдельно (сессии нет, /api/auth отвечает по сценарию); --only=auth запускает только его.
// Запуск: node tests/smoke.mjs [--root=<папка>] [--only=auth]   (Playwright: npm i --no-save playwright && npx playwright install chromium)
import path from 'node:path';
import { chromium } from 'playwright';
import { start } from './serve.mjs';

const arg = process.argv.find((a) => a.startsWith('--root='));
const root = arg ? path.resolve(arg.slice(7)) : undefined;

const ONLY_AUTH = process.argv.includes('--only=auth');
const PAGES = ONLY_AUTH ? [] : [['главная', ''], ['напоминания', '#reminders'], ['wifi', '#wifi'], ['агент', '#agent']];
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
for (const scheme of SCHEMES) {
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

await browser.close();
await stand.close();
console.log(failures ? `\nПровалено случаев: ${failures}` : '\nВсе случаи без замечаний');
process.exit(failures ? 1 : 0);
