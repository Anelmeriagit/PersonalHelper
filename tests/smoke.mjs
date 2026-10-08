// Дымовая проверка интерфейса в Chromium (Playwright) с CSP из vercel.json и мок-API.
// Для каждой страницы × ширины 360/1280 × светлой/тёмной темы проверяет:
//   нет нарушений CSP, нет ошибок JS и console.error, нет обращений к незамоканному API,
//   нет горизонтальной прокрутки.
// Гостевой режим: сайт без входа, кэшбэк, WiFi и агент в браузере (--only=guest), выход и конец сессии (--only=session), кэшбэк для одного человека (--only=cashback), личная сеть WiFi (--only=wifi),
// блок «Telegram» (--only=tg), вкладка «Напоминания» (--only=rem), аккаунт: Google, меню, настройки, удаление (--only=acct) и окно приветствия (--only=welcome), расход команд Redis: возврат на вкладку, опрос привязки, пауза сохранения (--only=refresh) проверяются отдельными сценариями.
// Во всех остальных сценариях флаг welcome=1 проставляется заранее, иначе окно приветствия перекрывало бы страницу.
// Запуск: node tests/smoke.mjs [--root=<папка>] [--only=guest|session|cashback|wifi|tg|rem|acct|welcome|refresh]   (Playwright: npm i --no-save playwright && npx playwright install chromium)
import path from 'node:path';
import { chromium } from 'playwright';
import { start } from './serve.mjs';
import { qr, mskDay } from './fixtures.mjs';
import { makeQr } from '../api/_qr.js';

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
        try { localStorage.setItem('theme', s); localStorage.setItem('welcome', '1'); } catch { /* нет доступа */ }
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

// ---------- гость: сайт открывается без входа, данные кэшбэка лежат в браузере, на сервер ничего не уходит ----------
const SETUP = (s) => {
  try { localStorage.setItem('theme', s); localStorage.setItem('welcome', '1'); } catch { /* нет доступа */ }
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
};
for (const scheme of run('guest') ? SCHEMES : []) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
    await ctx.addInitScript(SETUP, scheme);
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push('JS: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) problems.push('console: ' + m.text()); });
    // без сессии сервер отвечает 401: это и есть гость; до сервера запрос не доходит, поэтому всё, что дошло до стенда, лишнее
    await page.route('**/api/data', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"auth"}' }));
    const calls0 = stand.apiCalls.length, unm0 = stand.unmocked.length;
    const check = (cond, msg) => { if (!cond) problems.push(msg); };
    const text = (sel) => page.locator(sel).first().innerText();
    const vis = (sel) => page.locator(sel).first().isVisible();
    const noHScroll = async (where) => {
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
    };
    try {
      await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
      await page.waitForSelector('#mainNav', { state: 'visible', timeout: 5000 });
      check((await page.locator('#lf, #u, #pw').count()) === 0, 'гость: формы входа нет');
      check((await vis('#gBtn')) && !(await vis('#uWrap')), 'гость: в шапке кнопка Google, меню пользователя скрыто');
      check((await vis('#editBtn')) && (await vis('#themeBtn')), 'гость: кнопки правки и темы видны');
      check(await vis('#stage'), 'гость: страница кэшбэка открыта без входа');
      check((await page.locator('#bCur [data-act=add]').count()) === 1, 'гость: пустой месяц, есть «+ Добавить»');
      await noHScroll('гость: главная');

      // запись кэшбэка: сохраняется в браузере (localStorage), на сервер не уходит
      await page.click('#bCur [data-act=add]');
      await page.selectOption('#bCur select[data-k=bank]', 'otp');
      await page.selectOption('#bCur select[data-k=cat]', 'АЗС');
      await page.selectOption('#bCur select[data-k=pct]', '5');
      await page.click('[data-act=save]');
      await page.waitForFunction(() => /АЗС/.test(localStorage.getItem('g-cb') || ''), null, { timeout: 5000 });
      check((await page.locator('#bCur .blk').count()) === 1, 'гость: после сохранения виден один блок');
      await page.waitForFunction(() => document.getElementById('st').textContent === '✓', null, { timeout: 5000 });
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#bCur .blk', { timeout: 5000 });
      check(/АЗС/.test(await text('#bCur')) && /5%/.test(await text('#bCur')), 'гость: запись на месте после перезагрузки');

      // разделы, которым нужен аккаунт: предложение войти вместо содержимого
      await page.goto(stand.url + '/#reminders', { waitUntil: 'load' });
      await page.waitForSelector('#remGuest', { state: 'visible', timeout: 5000 });
      check(!(await vis('#remAcct')) && !(await vis('#tgBox')), 'напоминания гостя: блоки аккаунта скрыты');
      check((await page.locator('#remGuest .gbtn').count()) === 1 && (await page.getAttribute('#remGuest .gbtn', 'href')) === '/api/auth?action=google', 'напоминания гостя: кнопка Google ведёт на вход');
      check((await page.locator('#remGuest .gbtn').evaluate((el) => el.getBoundingClientRect().height)) >= 40, 'напоминания гостя: кнопка слишком мелкая');
      await noHScroll('напоминания гостя');

      // WiFi гостя: форма вместо предложения войти, сеть сохраняется в браузере, QR строит сайт, пароль на сервер не уходит
      await page.goto(stand.url + '/#wifi', { waitUntil: 'load' });
      await page.waitForSelector('#wForm', { state: 'visible', timeout: 5000 });
      check((await page.locator('#wifiGuest').count()) === 0, 'WiFi гостя: предложения войти нет');
      check(/в этом браузере/.test(await text('#wForm .wfn')), 'WiFi гостя: в форме сказано, что данные только в браузере');
      await noHScroll('WiFi гостя: форма');
      await page.fill('#wfSsid', 'GuestNet');
      await page.fill('#wfPw', 'guest-pass-1');
      await page.click('#wForm .done');
      await page.waitForSelector('.wqr svg.qr', { state: 'visible', timeout: 5000 });
      const wq = makeQr('WIFI:T:WPA;S:GuestNet;P:guest-pass-1;H:false;;');
      const wsvg = await page.evaluate(() => { const s = document.querySelector('.wqr svg.qr'); return { vb: s.getAttribute('viewBox'), d: s.querySelector('path').getAttribute('d') }; });
      check(wsvg.vb === `0 0 ${wq.size + 8} ${wq.size + 8}`, 'WiFi гостя: размер QR как у серверного: ' + wsvg.vb);
      const darkWant = wq.rows.join('').split('1').length - 1;
      check([...wsvg.d.matchAll(/h(\d+)v1/g)].reduce((n, m) => n + Number(m[1]), 0) === darkWant, 'WiFi гостя: тёмные модули QR как у серверного');
      check(/GuestNet/.test(await text('.wi')) && !/guest-pass-1/.test(await text('.wi')), 'WiFi гостя: название видно, пароль скрыт');
      const wl = await page.evaluate(() => localStorage.getItem('g-wf') || '');
      check(/GuestNet/.test(wl) && /guest-pass-1/.test(wl) && !/qr/.test(wl), 'WiFi гостя: сеть в браузере, без QR');
      await noHScroll('WiFi гостя: сеть');
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('.wqr svg.qr', { state: 'visible', timeout: 5000 });
      check(/GuestNet/.test(await text('.wi')), 'WiFi гостя: сеть на месте после перезагрузки');

      // агент гостя: четыре строки по умолчанию, время сохраняется в браузере, подпись «через …»
      await page.goto(stand.url + '/#agent', { waitUntil: 'load' });
      await page.waitForSelector('#agBody .agr', { state: 'visible', timeout: 5000 });
      check((await page.locator('#agentGuest').count()) === 0, 'агент гостя: предложения войти нет');
      check((await page.locator('#agBody .agr').count()) === 4, 'агент гостя: четыре строки по умолчанию');
      await noHScroll('агент гостя: список');
      const row0 = page.locator('#agBody .agr').first();
      await row0.locator('select[data-k=h]').selectOption('9');
      await row0.locator('select[data-k=m]').selectOption('30');
      await page.waitForFunction(() => /"h":9/.test(localStorage.getItem('g-ag') || '') && /"m":30/.test(localStorage.getItem('g-ag') || ''), null, { timeout: 7000 });
      const ag = await page.evaluate(() => JSON.parse(localStorage.getItem('g-ag')).rows);
      check(ag.length === 4 && ag[0].at > Date.now() && ag[1].at === null, 'агент гостя: момент сброса посчитан только у строки со временем');
      check(/через/.test(await row0.locator('.ags').innerText()), 'агент гостя: подпись «через …»');
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#agBody .agr', { state: 'visible', timeout: 5000 });
      check((await page.locator('#agBody .agr').first().locator('select[data-k=h]').inputValue()) === '9', 'агент гостя: время на месте после перезагрузки');
      await noHScroll('агент гостя: со временем');
      await page.goto(stand.url + '/', { waitUntil: 'load' });
      await page.waitForSelector('#mainNav', { state: 'visible', timeout: 5000 });
      check(!(await vis('#remAcct')) && (await page.locator('#remGuest').isHidden()), 'на главной предложение войти не показано');

      check(stand.apiCalls.length === calls0, 'гость: на сервер ушли запросы: ' + stand.apiCalls.slice(calls0).join(', '));
      check(stand.unmocked.length === unm0, 'нет заглушки API: ' + stand.unmocked.slice(unm0).join(', '));
      const csp = await page.evaluate(() => window.__csp);
      check(!csp.length, 'CSP: ' + csp.join('; '));
    } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  гостевой режим${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
    if (problems.length) failures++;
    await ctx.close();
  }
}

// ---------- из аккаунта в гостя: конец сессии (401) и выход; данные аккаунта заменяют гостевые ----------
for (const scheme of run('session') ? SCHEMES : []) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
    await ctx.addInitScript(SETUP, scheme);
    const page = await ctx.newPage();
    const problems = [];
    const posts = [];
    page.on('pageerror', (e) => problems.push('JS: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) problems.push('console: ' + m.text()); });
    await page.route('**/api/auth', (r) => { posts.push(r.request().postDataJSON()); r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
    const check = (cond, msg) => { if (!cond) problems.push(msg); };
    const vis = (sel) => page.locator(sel).first().isVisible();
    const local = () => page.evaluate(() => localStorage.getItem('g-cb') || '');
    try {
      // 1. в браузере уже есть гостевые данные (до входа)
      await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
      await page.evaluate(() => localStorage.setItem('g-cb', JSON.stringify({ months: {}, custom: ['Моя гостевая'], rev: {} })));
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 });
      check(!(await vis('#gBtn')), 'аккаунт: кнопки Google в шапке нет');

      // 2. сессия заканчивается во время правки: несохранённое остаётся, но уже в гостевых данных
      await page.route('**/api/data', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"auth"}' }) : r.fallback()));
      await page.click('#editBtn');
      await page.click('[data-act=addb]');
      await page.selectOption('#bCur .blk:last-of-type select[data-k=bank]', 'vtb');
      await page.selectOption('#bCur .blk:last-of-type select[data-k=cat]', 'Аптеки');
      await page.selectOption('#bCur .blk:last-of-type select[data-k=pct]', '3');
      await page.click('[data-act=save]');
      await page.waitForSelector('#gBtn', { state: 'visible', timeout: 6000 });
      check(!(await vis('#uWrap')) && (await vis('#mainNav')), '401: гость, навигация осталась');
      check((await page.locator('#lf').count()) === 0, '401: экрана входа нет');
      check(/гостевом режиме/.test(await page.locator('#warn').innerText()), '401: объяснение про гостевой режим');
      check((await page.locator('#bCur .blk').count()) === 4, '401: на странице данные аккаунта с правкой (4 банка)');
      const l1 = await local();
      check(/Аптеки/.test(l1) && /vtb/.test(l1) && /Маркетплейсы/.test(l1), '401: правка и данные аккаунта в гостевом хранилище');
      check(!/Моя гостевая/.test(l1), '401: прежние гостевые данные заменены');
      check(await vis('#editBtn'), '401: кнопка правки доступна гостю');
      await page.goto('about:blank');
      await page.goto(stand.url + '/', { waitUntil: 'load' });
      await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 }); // стенд снова отвечает как аккаунт

      // 2b. сессия заканчивается на странице «Агент»: строки (с правкой) и сеть аккаунта заменяют гостевые
      await page.evaluate(() => {
        localStorage.setItem('g-wf', JSON.stringify({ ssid: 'GuestNet', password: 'guest-pass-1', security: 'WPA', hidden: false }));
        localStorage.setItem('g-ag', JSON.stringify({ rows: [{ id: 'gg', app: 'Моя гостевая', h: null, m: null, at: null }] }));
        location.hash = '#wifi';
      });
      await page.waitForSelector('.wqr svg.qr', { state: 'visible', timeout: 5000 }); // сеть аккаунта загружена в память
      await page.evaluate(() => { location.hash = '#agent'; });
      await page.waitForSelector('#agBody .agr', { state: 'visible', timeout: 5000 });
      await page.route('**/api/agent', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"auth"}' }) : r.fallback()));
      await page.locator('#agBody .agr').first().locator('select[data-k=h]').selectOption('7');
      await page.locator('#agBody .agr').first().locator('select[data-k=m]').selectOption('20');
      await page.waitForSelector('#gBtn', { state: 'visible', timeout: 8000 });
      const l3 = await page.evaluate(() => ({ ag: localStorage.getItem('g-ag') || '', wf: localStorage.getItem('g-wf') || '' }));
      check(/"id":"a1"/.test(l3.ag) && /"h":7/.test(l3.ag) && /"m":20/.test(l3.ag) && !/Моя гостевая/.test(l3.ag), '401 на «Агенте»: строки аккаунта с правкой заменили гостевые');
      check(/TestNet/.test(l3.wf) && /test-password/.test(l3.wf) && !/GuestNet/.test(l3.wf), '401 на «Агенте»: сеть аккаунта заменила гостевую');
      check((await page.locator('#agBody .agr').count()) === 4 && (await page.locator('#agBody .agr').first().locator('select[data-k=h]').inputValue()) === '7', '401 на «Агенте»: на странице те же строки с правкой');
      check(/гостевом режиме/.test(await page.locator('#warn').innerText()), '401 на «Агенте»: объяснение про гостевой режим');
      await page.goto('about:blank');
      await page.unroute('**/api/agent');
      await page.goto(stand.url + '/', { waitUntil: 'load' });
      await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 });

      // 3. выход: свежие данные аккаунта заменяют гостевые
      await page.unroute('**/api/data');
      await page.evaluate(() => {
        localStorage.setItem('g-cb', JSON.stringify({ months: {}, custom: ['Ещё гостевая'], rev: {} }));
        localStorage.setItem('g-wf', JSON.stringify({ ssid: 'GuestNet', password: 'guest-pass-1', security: 'WPA', hidden: false }));
        localStorage.setItem('g-ag', JSON.stringify({ rows: [{ id: 'gg', app: 'Моя гостевая', h: null, m: null, at: null }] }));
      });
      await page.goto('about:blank');
      await page.goto(stand.url + '/', { waitUntil: 'load' });
      await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 });
      await page.click('#uBtn'); await page.click('#uMenu [data-u=logout]');
      await page.waitForSelector('#gBtn', { state: 'visible', timeout: 5000 });
      check(posts.filter((x) => x.action === 'logout').length === 1, 'выход: запрос logout');
      const l2 = await local();
      check(/Маркетплейсы/.test(l2) && !/Ещё гостевая/.test(l2), 'выход: данные аккаунта заменили гостевые: ' + l2.slice(0, 80));
      check((await page.locator('#bCur .blk').count()) === 3 && (await vis('#mainNav')), 'выход: на странице данные аккаунта, навигация на месте');
      const l4 = await page.evaluate(() => ({ ag: localStorage.getItem('g-ag') || '', wf: localStorage.getItem('g-wf') || '' }));
      check(/"id":"a1"/.test(l4.ag) && !/Моя гостевая/.test(l4.ag), 'выход: строки агента аккаунта заменили гостевые');
      check(/TestNet/.test(l4.wf) && !/GuestNet/.test(l4.wf), 'выход: сеть аккаунта заменила гостевую');
      check((await page.locator('#lf').count()) === 0, 'выход: экрана входа нет');
      const csp = await page.evaluate(() => window.__csp);
      check(!csp.length, 'CSP: ' + csp.join('; '));
    } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  из аккаунта в гостя${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
    if (problems.length) failures++;
    await ctx.close();
  }
}

// ---------- кэшбэк для одного человека ----------
for (const scheme of run('cashback') ? SCHEMES : []) {
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
    if (problems.length) failures++;
    await ctx.close();
  }
}

// ---------- личная сеть WiFi: форма, сохранение, правка, удаление ----------
for (const scheme of run('wifi') ? SCHEMES : []) {
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
      await page.press('#wfPw', 'Enter'); // кнопка «Сохранить» под сообщением об ошибке на 360 px не ловит щелчок Playwright (на странице под указателем кнопка), отправляем с клавиатуры
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

// ---------- блок «Telegram»: не привязан → ссылка → привязан → отвязка, отказы, 429, экранирование, 401 ----------
for (const scheme of run('tg') ? SCHEMES : []) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
    await ctx.addInitScript((s) => {
      try { localStorage.setItem('theme', s); localStorage.setItem('welcome', '1'); } catch { /* нет доступа */ }
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    }, scheme);
    const page = await ctx.newPage();
    const problems = [];
    const st = { linked: false, username: 'ivan_k', post: 'ok', del: 'ok', auth: false, posts: 0, dels: 0, rem: 0 };
    page.on('pageerror', (e) => problems.push('JS: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|429|500|503)/.test(m.text())) problems.push('console: ' + m.text()); });
    // состояние привязки и @имя приходят в ответе напоминаний (отдельного GET /api/tglink при входе на страницу нет); 401 как у настоящего сервера
    await page.route('**/api/reminders', (r) => {
      st.rem++;
      if (st.auth) return r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'auth' }) });
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ linked: st.linked, ...(st.linked ? { username: st.username } : {}), custom: [], recurring: [] }) });
    });
    await page.route('**/api/tglink', (r) => {
      const m = r.request().method();
      const send = (status, body) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (st.auth) return send(401, { error: 'auth' });
      if (m === 'GET') return send(200, st.linked ? { linked: true, username: st.username } : { linked: false });
      if (m === 'POST') {
        st.posts++;
        if (st.post === '429') return send(429, { error: 'Слишком часто. Подождите несколько минут.' });
        if (st.post === '503') return send(503, { error: 'Бот сейчас недоступен. Попробуйте позже.' });
        return send(200, { url: 'https://t.me/TestBot?start=AAAAAAAAAAAAAAAAAAAAAA', ttl: 600 });
      }
      st.dels++;
      if (st.del === '500') return send(500, { error: 'x' });
      st.linked = false;
      return send(200, { linked: false });
    });
    const check = (cond, msg) => { if (!cond) problems.push(msg); };
    const text = (sel) => page.locator(sel).first().innerText();
    const noHScroll = async (where) => {
      const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
    };
    try {
      // 1. не привязан
      await page.goto(stand.url + '/#reminders', { waitUntil: 'load', timeout: 15000 });
      await page.waitForSelector('#tgBody [data-t=link]', { timeout: 5000 });
      check(/Привязать Telegram/.test(await text('#tgBody [data-t=link]')), 'не привязан: кнопка «Привязать Telegram»');
      await page.waitForSelector('#remWarn:not([hidden])', { timeout: 5000 });
      check(/не привязан/.test(await text('#remWarn')), 'не привязан: предупреждение про привязку');
      check(!/Бот ещё не подключён/i.test(await page.locator('#remStage').innerText()), 'нет старого предупреждения про бота');
      await noHScroll('не привязан');

      // 2. отказ сервера при выдаче ссылки
      st.post = '503';
      await page.click('#tgBody [data-t=link]');
      await page.waitForFunction(() => document.getElementById('tgMsg').textContent.length > 0, null, { timeout: 5000 });
      check(/Бот сейчас недоступен/.test(await text('#tgMsg')), 'отказ 503: текст сервера в #tgMsg «' + (await text('#tgMsg')) + '»');
      check((await page.locator('#tgBody [data-t=link]').count()) === 1 && (await page.locator('#tgBody a.btn').count()) === 0, 'отказ 503: остаётся кнопка, ссылки нет');
      await noHScroll('отказ 503');

      // 3. ссылка выдана
      st.post = 'ok';
      await page.click('#tgBody [data-t=link]');
      await page.waitForSelector('#tgBody a.btn', { timeout: 5000 });
      const a = page.locator('#tgBody a.btn');
      check((await a.getAttribute('href')).startsWith('https://t.me/TestBot?start='), 'ссылка: href ведёт на t.me');
      check((await a.getAttribute('target')) === '_blank' && /noopener/.test(await a.getAttribute('rel')), 'ссылка: target=_blank и noopener');
      check((await page.locator('#tgBody [data-t=link]').count()) === 1, 'ссылка: есть «Получить новую ссылку»');
      check((await text('#tgMsg')) === '', 'ссылка: сообщение об ошибке сброшено');
      await noHScroll('ссылка выдана');

      // 4. 429 на новую ссылку: прежняя ссылка остаётся на экране
      st.post = '429';
      await page.click('#tgBody [data-t=link]');
      await page.waitForFunction(() => document.getElementById('tgMsg').textContent.length > 0, null, { timeout: 5000 });
      check(/Слишком часто/.test(await text('#tgMsg')), '429: текст сервера в #tgMsg');
      check((await page.locator('#tgBody a.btn').count()) === 1, '429: прежняя ссылка осталась');
      await noHScroll('429');

      // 5. «Запустить» нажато: опрос раз в 4 с замечает привязку, предупреждение исчезает после перезагрузки списка
      const before = st.rem;
      st.linked = true;
      await page.waitForSelector('#tgBody .tgn b', { timeout: 9000 });
      check((await text('#tgBody .tgn b')) === '@ivan_k', 'привязан: показан @ivan_k');
      check((await page.locator('#tgBody [data-t=unlink]').count()) === 1 && (await page.locator('#tgBody a.btn').count()) === 0, 'привязан: есть «Отвязать», ссылки нет');
      check((await text('#tgMsg')) === 'Telegram привязан', 'привязан: сообщение');
      await page.waitForSelector('#remWarn[hidden]', { state: 'attached', timeout: 5000 });
      check(st.rem > before, 'после привязки список напоминаний перезапрошен');
      check(await page.locator('#remWarn').isHidden(), 'после привязки предупреждения нет');
      await noHScroll('привязан');

      // 6. «Отмена» в диалоге отвязки: запроса нет
      await page.click('#tgBody [data-t=unlink]');
      await page.waitForSelector('#dlg[open]', { timeout: 3000 });
      await page.click('#dlgNo');
      await page.waitForSelector('#dlg[open]', { state: 'detached', timeout: 3000 });
      check(st.dels === 0, 'отмена отвязки: DELETE не отправлялся');

      // 7. отказ при отвязке: остаётся «привязан»
      st.del = '500';
      await page.click('#tgBody [data-t=unlink]');
      await page.waitForSelector('#dlg[open]', { timeout: 3000 });
      await page.click('#dlg .done');
      await page.waitForFunction(() => /отвязать/.test(document.getElementById('tgMsg').textContent), null, { timeout: 5000 });
      check((await page.locator('#tgBody .tgn b').count()) === 1, 'отказ отвязки: остаётся «привязан»');

      // 8. отвязка: снова «не привязан», предупреждение вернулось
      st.del = 'ok';
      await page.click('#tgBody [data-t=unlink]');
      await page.waitForSelector('#dlg[open]', { timeout: 3000 });
      await page.click('#dlg .done');
      await page.waitForSelector('#tgBody [data-t=link]', { timeout: 5000 });
      await page.waitForSelector('#remWarn:not([hidden])', { timeout: 5000 });
      check(st.dels === 2, 'отвязка: два DELETE (отказ и успех), всего ' + st.dels);
      await noHScroll('после отвязки');

      // 9. экранирование имени из ответа сервера
      st.linked = true; st.username = '<img src=x onerror=1>';
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#tgBody .tgn b', { timeout: 5000 });
      check((await page.locator('#tgBody img').count()) === 0, 'имя экранируется: тега img нет');
      check((await text('#tgBody .tgn b')) === '@<img src=x onerror=1>', 'имя показано текстом');
      await noHScroll('длинное имя');

      // 10. 401 от /api/tglink: сессии нет, сайт открывается гостем
      st.auth = true;
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#gBtn', { state: 'visible', timeout: 5000 });
      check(await page.locator('#mainNav').isVisible() && (await page.locator('#lf').count()) === 0, '401: гость, навигация видна, экрана входа нет');
      const csp = await page.evaluate(() => window.__csp);
      check(!csp.length, 'CSP: ' + csp.join('; '));
    } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  telegram: привязка${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
    if (problems.length) failures++;
    await ctx.close();
  }
}

// ---------- «Напоминания»: две колонки, без «Кому», создание, переключатель, удаление ----------
for (const scheme of run('rem') ? SCHEMES : []) {
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
    const pickDay = async (formSel) => {
      if ((await page.locator(`${formSel} [data-d="${tomorrow}"]`).count()) === 0) await page.click(`${formSel} [data-nav="1"]`);
      await page.click(`${formSel} [data-d="${tomorrow}"]`);
    };
    try {
      await page.goto(stand.url + '/#reminders', { waitUntil: 'load', timeout: 15000 });
      await page.waitForSelector('#tmpList .rc', { timeout: 5000 });
      await page.waitForSelector('#recList .rc', { timeout: 5000 });
      // разметка
      check((await page.locator('#remStage .rcol').count()) === 2, 'две колонки вместо трёх');
      check((await page.locator('#remBody').count()) === 0 && !/Постоянные/.test(await page.locator('#remStage').innerText()), 'колонки «Постоянные» нет');
      check(!/Кому|Денис|Жанна/.test(await page.locator('#remStage').innerText()), 'на вкладке нет «Кому», Дениса и Жанны');
      check((await page.locator('#remStage input[type=checkbox]').count()) === 0, 'галок получателей нет');
      const xs = await page.locator('#remStage .rcol').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
      if (vp.width >= 900) check(xs[0] !== xs[1], 'на 1280 px колонки рядом');
      else check(xs[0] === xs[1], 'на 360 px колонки друг под другом');
      check((await page.locator('#tmpList .tt b').count()) === 0 && /<b>маме<\/b>/.test(await page.locator('#tmpList .tt').innerText()), 'текст напоминания экранирован');
      await noHScroll('вкладка');

      // переключатель: PUT только {id, key:'on', value}
      await page.click('#tmpList .sw');
      await page.waitForFunction(() => /Сохранено/.test(document.getElementById('remMsg').textContent), null, { timeout: 5000 });
      check(JSON.stringify(calls[calls.length - 1]) === JSON.stringify(['PUT', 'custom', { id: 'aaaaaaaaaaaa', key: 'on', value: false }]), 'переключатель: тело PUT ' + JSON.stringify(calls[calls.length - 1]));
      check((await page.locator('#tmpList .rc.off').count()) === 1, 'выключенная карточка серая');

      // создание временного
      await page.click('#tmpAdd');
      await pickDay('#tmpForm');
      await page.click('#tmpForm [data-s=day]');
      await page.click('#tmpForm [data-f=save]');
      check(/Напишите текст/.test(await page.locator('#fmErr').innerText()), 'пустой текст: сообщение');
      check(!calls.some((c) => c[0] === 'POST'), 'пустой текст: запроса нет');
      await page.fill('#tText', 'Купить хлеб');
      await noHScroll('форма временного');
      await page.click('#tmpForm [data-f=save]');
      await page.waitForFunction(() => document.querySelectorAll('#tmpList .rc').length === 2, null, { timeout: 5000 });
      const pc = calls.filter((c) => c[0] === 'POST' && c[1] === 'custom')[0];
      check(JSON.stringify(pc && pc[2]) === JSON.stringify({ date: tomorrow, slot: 'day', text: 'Купить хлеб' }), 'POST /api/custom без who: ' + JSON.stringify(pc && pc[2]));

      // создание повторяющегося
      await page.click('#recAdd');
      await pickDay('#recForm');
      await page.click('#recForm [data-e=week]');
      await page.click('#recForm [data-s=evening]');
      await page.fill('#tText', 'Счётчики');
      await noHScroll('форма повторяющегося');
      await page.click('#recForm [data-f=save]');
      await page.waitForFunction(() => document.querySelectorAll('#recList .rc').length === 2, null, { timeout: 5000 });
      const pr = calls.filter((c) => c[0] === 'POST' && c[1] === 'recurring')[0];
      check(JSON.stringify(pr && pr[2]) === JSON.stringify({ date: tomorrow, slot: 'evening', text: 'Счётчики', every: 'week' }), 'POST /api/recurring без who: ' + JSON.stringify(pr && pr[2]));

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
    if (problems.length) failures++;
    await ctx.close();
  }
}

// ---------- аккаунт: кнопка Google, меню, окно «Настройки аккаунта», имя, отвязка Telegram, удаление, выход ----------
for (const scheme of run('acct') ? SCHEMES : []) {
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
    const openSettings = async () => { await page.click('#uBtn'); await page.click('#uMenu [data-u=settings]'); await page.waitForSelector('#acctDlg .ar', { timeout: 5000 }); };
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
      check(gb && tb && gb.x + gb.width <= tb.x && gb.x + gb.width <= vp.width && gb.height >= 44, 'кнопка Google слева от переключателя темы, не выходит за экран, высота ≥ 44 px');
      check(gb && gb.x > vp.width / 2 - gb.width, 'кнопка Google в правой части шапки');
      await noHScroll('без входа');

      // --- вошли: «Helper User» и галочка ---
      await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
      await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 });
      check(!(await vis('#gBtn')), 'после входа кнопка Google скрыта');
      check((await text('#uName')) === 'Helper User', 'имя в шапке по умолчанию: «' + (await text('#uName')) + '»');
      check((await page.locator('#uBtn svg').count()) === 1, 'у кнопки есть галочка');
      check((await page.locator('#outBtn').count()) === 0, 'старой кнопки выхода нет');
      const ub = await page.locator('#uBtn').boundingBox();
      check(ub && ub.height >= 44 && ub.x + ub.width <= vp.width, 'кнопка пользователя: высота ≥ 44 px, не выходит за экран');
      await noHScroll('шапка вошедшего');

      // --- меню ---
      await page.click('#uBtn');
      check(await vis('#uMenu'), 'меню открывается');
      check((await page.getAttribute('#uBtn', 'aria-expanded')) === 'true', 'aria-expanded=true');
      check((await page.locator('#uMenu [role=menuitem]').allInnerTexts()).join('|') === 'Настройки аккаунта|Выйти', 'пункты меню');
      const mb = await page.locator('#uMenu').boundingBox();
      check(mb && mb.x >= 0 && mb.x + mb.width <= vp.width, 'меню внутри экрана');
      await page.keyboard.press('Escape');
      check(!(await vis('#uMenu')) && (await page.evaluate(() => document.activeElement.id)) === 'uBtn', 'Escape закрывает меню и возвращает фокус');
      await page.click('#uBtn');
      await page.mouse.click(4, 400);
      check(!(await vis('#uMenu')), 'клик вне меню закрывает его');

      // --- окно настроек: ошибка загрузки ---
      meFail = true; await page.click('#uBtn'); await page.click('#uMenu [data-u=settings]');
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
      check(/ID 123456789/.test(dlgT) && /@anna_tg<i>x<\/i>/.test(dlgT), 'Telegram: ID и имя текстом');
      check((await page.locator('#acctDlg u, #acctDlg i').count()) === 0, 'Email и имя Telegram не создают разметку (экранирование)');
      check((await page.locator('#acctDlg [data-a=unlink]').count()) === 1, 'кнопка «Отвязать»');
      check(/Соединить аккаунты/.test(dlgT) && (await page.locator('#acctDlg .ar button[disabled]').count()) === 1, 'поле «Соединить аккаунты» (кнопка пока недоступна)');
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
      await page.waitForSelector('#uBtn', { state: 'visible', timeout: 5000 });
      await page.click('#uBtn'); await page.click('#uMenu [data-u=logout]');
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
    if (problems.length) failures++;
    await ctx.close();
  }
}

// ---------- окно приветствия ----------
// Без флага welcome окно открывается один раз на браузер; кнопка и Esc закрывают его и ставят флаг; после перезагрузки его нет.
for (const scheme of run('welcome') ? SCHEMES : []) {
  for (const vp of [...VIEWPORTS, { width: 360, height: 500 }]) { // низкий экран: длинный текст прокручивается внутри окна
    for (const loggedIn of [false, true]) {
      const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
      await ctx.addInitScript((s) => {
        try { localStorage.setItem('theme', s); } catch { /* нет доступа */ }
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
      }, scheme);
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/status of 401/.test(m.text())) problems.push('console: ' + m.text()); });
      if (!loggedIn) await page.route('**/api/data', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"auth"}' }));
      const before = stand.unmocked.length;
      const check = (cond, msg) => { if (!cond) problems.push(msg); };
      const isOpen = () => page.evaluate(() => document.getElementById('welcome').open);
      const flag = () => page.evaluate(() => localStorage.getItem('welcome'));
      // событие close у <dialog> приходит чуть позже самого закрытия: флаг и фокус ждём, а не читаем сразу
      const flagSet = () => page.waitForFunction(() => localStorage.getItem('welcome') === '1', null, { timeout: 2000 }).then(() => true, () => false);
      const noHScroll = async (where) => {
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check(r.sw <= r.iw, `${where}: горизонтальная прокрутка ${r.sw} > ${r.iw}`);
      };
      const ready = () => page.waitForSelector('#mainNav', { state: 'visible', timeout: 5000 });
      try {
        await page.goto(stand.url + '/', { waitUntil: 'load', timeout: 15000 });
        await ready();
        check(await isOpen(), 'первый заход: окно не открылось');
        check((await page.locator('#wlcT').innerText()) === 'Добро пожаловать в Personal Helper', 'заголовок окна');
        check((await page.locator('#welcome').getAttribute('aria-labelledby')) === 'wlcT', 'у окна нет aria-labelledby');
        const hb = await page.locator('#wlcT').boundingBox();
        check(hb && hb.y >= 0 && hb.y + hb.height <= vp.height, 'заголовок окна не виден при открытии: ' + JSON.stringify(hb));
        const box = await page.locator('#welcome').boundingBox();
        check(box && box.x >= 0 && box.x + box.width <= vp.width && box.y >= 0 && box.y + box.height <= vp.height, 'окно не помещается в экран: ' + JSON.stringify(box));
        const bh = await page.locator('#welcome .done').evaluate((el) => el.getBoundingClientRect().height);
        check(bh >= 40, 'кнопка слишком мелкая: ' + Math.round(bh) + ' px');
        check((await flag()) === null, 'флаг welcome поставлен до закрытия окна');
        await noHScroll('окно приветствия');

        await page.click('#welcome .done');
        check(!(await isOpen()), 'кнопка не закрыла окно');
        check(await flagSet(), 'после закрытия кнопкой флаг welcome не поставлен');
        await noHScroll('после закрытия');

        await page.reload({ waitUntil: 'load' });
        await ready();
        await page.waitForTimeout(200);
        check(!(await isOpen()), 'после перезагрузки окно открылось снова');

        // Esc закрывает окно так же, как кнопка
        await page.evaluate(() => { localStorage.removeItem('welcome'); });
        await page.reload({ waitUntil: 'load' });
        await ready();
        check(await isOpen(), 'без флага окно не открылось после перезагрузки');
        await page.keyboard.press('Escape');
        check(!(await isOpen()), 'Esc не закрыл окно');
        check(await flagSet(), 'после Esc флаг welcome не поставлен');

        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
        check(stand.unmocked.length === before, 'нет заглушки API: ' + stand.unmocked.slice(before).join(', '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px ${String(vp.height).padStart(4)} высота  окно приветствия, ${loggedIn ? 'вошедший' : 'гость'}${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) failures++;
      await ctx.close();
    }
  }
}

// ---------- меньше команд Redis: возврат на вкладку не чаще раза в 5 минут, привязка без лишних запросов, опрос с растущими паузами, пауза сохранения ----------
// Время подменяется (page.clock): 5 минут и 10 минут проходят за секунды. Видимость вкладки подменяется вручную (document.visibilityState + событие).
const MIN5 = 5 * 60 * 1000;
for (const scheme of run('refresh') ? SCHEMES : []) {
  for (const vp of VIEWPORTS) {
    const problems = [];
    const ctxs = [];
    const check = (cond, msg) => { if (!cond) problems.push(msg); };
    const n = (key, from = 0) => stand.apiCalls.slice(from).filter((k) => k === key).length;
    const settle = (page) => page.waitForTimeout(150);
    const setVis = (page, v) => page.evaluate((x) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => x }); document.dispatchEvent(new Event('visibilitychange')); }, v);
    const back = async (page) => { await setVis(page, 'hidden'); await setVis(page, 'visible'); await settle(page); };
    const openPage = async (iso, hash, setup) => {
      const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme });
      ctxs.push(ctx);
      await ctx.addInitScript((s) => {
        try { localStorage.setItem('theme', s); localStorage.setItem('welcome', '1'); } catch { /* нет доступа */ }
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
      }, scheme);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => problems.push('JS: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
      if (setup) await setup(page);
      await page.clock.install({ time: new Date(iso) });
      await page.goto(stand.url + '/' + hash, { waitUntil: 'load', timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await settle(page);
      return page;
    };
    const before = stand.unmocked.length;
    try {
      // 1. кэшбэк: возврат на вкладку в течение 5 минут запроса не делает, после 5 минут делает
      {
        const t0 = stand.apiCalls.length;
        const page = await openPage('2026-10-15T09:00:00Z', '');
        await page.waitForSelector('#bCur .col', { timeout: 5000 });
        check(n('GET /api/data', t0) === 1, 'кэшбэк: при входе один GET /api/data, было ' + n('GET /api/data', t0));
        for (let i = 0; i < 3; i++) await back(page);
        check(n('GET /api/data', t0) === 1, 'кэшбэк: три возврата на вкладку за 5 минут не должны читать данные, всего GET /api/data ' + n('GET /api/data', t0));
        await page.clock.fastForward(MIN5 + 1000);
        await back(page);
        check(n('GET /api/data', t0) === 2, 'кэшбэк: через 5 минут возврат на вкладку обновляет данные, всего GET /api/data ' + n('GET /api/data', t0));
        await back(page);
        check(n('GET /api/data', t0) === 2, 'кэшбэк: сразу после обновления повторного чтения нет');
      }

      // 2. смена месяца обновляет сразу, хотя пять минут не прошло
      {
        const t0 = stand.apiCalls.length;
        const page = await openPage('2026-10-31T20:58:00Z', '');
        await page.waitForSelector('#bCur .col', { timeout: 5000 });
        await page.clock.setSystemTime(new Date('2026-10-31T21:01:00Z')); // 00:01 по Москве, 1 ноября
        await back(page);
        check(n('GET /api/data', t0) === 2, 'смена месяца: возврат на вкладку обновляет сразу, всего GET /api/data ' + n('GET /api/data', t0));
      }

      // 3. напоминания, WiFi, агент: вход и переход на раздел грузят всегда, возврат на вкладку не чаще раза в 5 минут; привязка Telegram без отдельного запроса
      {
        const t0 = stand.apiCalls.length;
        const page = await openPage('2026-10-15T09:00:00Z', '#reminders');
        await page.waitForSelector('#tgBody .tgn b', { timeout: 5000 });
        check(n('GET /api/reminders', t0) === 1, 'напоминания: при входе один GET /api/reminders, было ' + n('GET /api/reminders', t0));
        check(n('GET /api/tglink', t0) === 0, 'напоминания: при входе на страницу нет GET /api/tglink, было ' + n('GET /api/tglink', t0));
        check((await page.locator('#tgBody .tgn b').innerText()) === '@ivan_k', 'блок Telegram показывает @имя из ответа напоминаний');
        await back(page); await back(page);
        check(n('GET /api/reminders', t0) === 1 && n('GET /api/tglink', t0) === 0, 'напоминания: возвраты на вкладку за 5 минут запросов не делают');
        await page.clock.fastForward(MIN5 + 1000);
        await back(page);
        check(n('GET /api/reminders', t0) === 2, 'напоминания: через 5 минут возврат обновляет список');
        check(n('GET /api/tglink', t0) === 0, 'напоминания: и при возврате на вкладку нет GET /api/tglink, было ' + n('GET /api/tglink', t0));

        await page.evaluate(() => { location.hash = '#wifi'; }); await settle(page);
        check(n('GET /api/wifi', t0) === 1, 'WiFi: переход на раздел грузит данные');
        await back(page);
        check(n('GET /api/wifi', t0) === 1, 'WiFi: возврат на вкладку за 5 минут запроса не делает');
        await page.clock.fastForward(MIN5 + 1000);
        await back(page);
        check(n('GET /api/wifi', t0) === 2, 'WiFi: через 5 минут возврат обновляет');

        await page.evaluate(() => { location.hash = '#reminders'; }); await settle(page);
        check(n('GET /api/reminders', t0) === 3, 'напоминания: переход на раздел грузит сразу, даже если данные свежие, всего ' + n('GET /api/reminders', t0));

        await page.evaluate(() => { location.hash = '#agent'; }); await settle(page);
        check(n('GET /api/agent', t0) === 1, 'агент: переход на раздел грузит строки один раз, было ' + n('GET /api/agent', t0));
        await back(page);
        check(n('GET /api/agent', t0) === 1, 'агент: возврат на вкладку за 5 минут запроса не делает');
        await page.clock.fastForward(MIN5 + 1000);
        await back(page);
        check(n('GET /api/agent', t0) === 2, 'агент: через 5 минут возврат обновляет строки');
      }

      // 4. опрос привязки: паузы растут (4 → 8 → 15 с), скрытая вкладка не опрашивается, при возврате одна проверка, через 10 минут стоп
      {
        const page = await openPage('2026-10-15T09:00:00Z', '#reminders', async (p) => {
          await p.route('**/api/reminders', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ linked: false, custom: [], recurring: [] }) }));
        });
        await page.waitForSelector('#tgBody [data-t=link]', { timeout: 5000 });
        await page.click('#tgBody [data-t=link]');
        await page.waitForSelector('#tgBody a.btn', { timeout: 5000 });
        const t1 = stand.apiCalls.length;
        const polls = () => n('GET /api/tglink', t1);
        const step = async (ms) => { await page.clock.runFor(ms); await page.waitForTimeout(12); };
        let el = 0;
        for (; el < 20000; el += 2000) await step(2000);
        check(polls() >= 4 && polls() <= 6, 'опрос: в первые 20 с от 4 до 6 запросов (шаг 4 с), было ' + polls());
        await setVis(page, 'hidden');
        const h0 = polls();
        for (let i = 0; i < 30; i++, el += 2000) await step(2000);
        check(polls() === h0, 'опрос: пока вкладка скрыта, запросов нет, было ' + (polls() - h0));
        await setVis(page, 'visible'); await settle(page);
        check(polls() === h0 + 1, 'опрос: при возврате на вкладку одна проверка сразу, было ' + (polls() - h0));
        let at300 = -1;
        for (; el < 640000; el += 2000) { await step(2000); if (at300 < 0 && el >= 300000) at300 = polls(); }
        const total = polls();
        check(total >= 25 && total <= 60, 'опрос за 10 минут: от 25 до 60 запросов (раньше было 150), было ' + total);
        check(total - at300 <= 22, 'опрос: во вторые 5 минут пауза 15 с, не больше 22 запросов, было ' + (total - at300));
        await page.waitForFunction(() => /Ссылка устарела/.test(document.getElementById('tgMsg').textContent), null, { timeout: 3000 });
        for (let i = 0; i < 30; i++) await step(2000);
        check(polls() === total, 'опрос: после срока ссылки запросов нет, было ' + (polls() - total));
      }

      // 5. сохранение: пауза перед записью 1,8 с; при уходе со вкладки правка уходит сразу
      {
        const t0 = stand.apiCalls.length;
        const page = await openPage('2026-10-15T09:00:00Z', '');
        await page.waitForSelector('#bCur .col', { timeout: 5000 });
        const edit = async () => {
          await page.click('#editBtn');
          const sel = page.locator('#bCur select[data-k=pct]').first();
          const cur = await sel.inputValue();
          const vals = await sel.evaluate((el) => Array.from(el.options).map((o) => o.value));
          await sel.selectOption(vals.filter((v) => v && v !== cur)[0]);
          await page.click('#editBtn');
        };
        await edit();
        await page.clock.runFor(1000); await settle(page);
        check(n('PUT /api/data', t0) === 0, 'кэшбэк: через 1 с после правки записи ещё нет, было ' + n('PUT /api/data', t0));
        await page.clock.runFor(900); await settle(page);
        check(n('PUT /api/data', t0) === 1, 'кэшбэк: через 1,9 с запись ушла, было ' + n('PUT /api/data', t0));
        await edit();
        await setVis(page, 'hidden'); await settle(page);
        check(n('PUT /api/data', t0) === 2, 'кэшбэк: при уходе со вкладки правка сохраняется сразу, не дожидаясь паузы, было ' + n('PUT /api/data', t0));

        await page.evaluate(() => { location.hash = '#agent'; });
        await setVis(page, 'visible');
        await page.waitForSelector('.agr select[data-k=h]', { timeout: 5000 });
        const a0 = stand.apiCalls.length;
        const pick = async (i) => page.locator('.agr select[data-k=h]').first().selectOption({ index: i });
        await pick(3);
        await page.clock.runFor(1000); await settle(page);
        check(n('PUT /api/agent', a0) === 0, 'агент: через 1 с после правки записи ещё нет, было ' + n('PUT /api/agent', a0));
        await page.clock.runFor(900); await settle(page);
        check(n('PUT /api/agent', a0) === 1, 'агент: через 1,9 с запись ушла, было ' + n('PUT /api/agent', a0));
        await pick(5);
        await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await settle(page);
        check(n('PUT /api/agent', a0) === 2, 'агент: при закрытии страницы правка сохраняется сразу, было ' + n('PUT /api/agent', a0));
        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
      }
      check(stand.unmocked.length === before, 'нет заглушки API: ' + stand.unmocked.slice(before).join(', '));
    } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  меньше команд Redis: возврат на вкладку, опрос, сохранение${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
    if (problems.length) failures++;
    for (const c of ctxs) await c.close();
  }
}

await browser.close();
await stand.close();
console.log(failures ? `\nПровалено случаев: ${failures}` : '\nВсе случаи без замечаний');
process.exit(failures ? 1 : 0);
