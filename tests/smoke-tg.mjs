// Сценарий smoke.mjs --only=tg (общие настройки и заглушки: smoke-lib.mjs, fixtures.mjs).
import { SCHEMES, VIEWPORTS } from './smoke-lib.mjs';

// ---------- блок «Telegram»: не привязан → ссылка → привязан → отвязка, отказы, 429, экранирование, 401 ----------

export async function tg({ stand, browser, fail }) {
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
        await page.waitForSelector('#tgBox.ok #tgBody .tgn', { timeout: 9000 });
        check((await text('#tgBody .tgn')) === 'Telegram привязан. Бот будет отправлять напоминания.', 'привязан: текст «' + (await text('#tgBody .tgn')) + '»');
        check((await page.locator('#tgBody button, #tgBody a').count()) === 0, 'привязан: ни «Отвязать», ни ссылки');
        check(await page.locator('#tgH').isHidden(), 'привязан: заголовка «Telegram» нет');
        check((await text('#tgMsg')) === '', 'привязан: сообщения нет');
        await page.waitForSelector('#remWarn[hidden]', { state: 'attached', timeout: 5000 });
        check(st.rem > before, 'после привязки список напоминаний перезапрошен');
        check(await page.locator('#remWarn').isHidden(), 'после привязки предупреждения нет');
        await noHScroll('привязан');

        // 6. отвязка сделана в настройках: после перезагрузки снова «не привязан», предупреждение вернулось
        st.linked = false;
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#tgBody [data-t=link]', { timeout: 5000 });
        await page.waitForSelector('#remWarn:not([hidden])', { timeout: 5000 });
        check((await page.locator('#tgBox.ok').count()) === 0 && await page.locator('#tgH').isVisible(), 'не привязан: обычный блок с заголовком');
        check(st.dels === 0, 'на странице напоминаний DELETE не отправляется');
        await noHScroll('после отвязки');

        // 9. имя из ответа сервера в блоке не показывается (и не создаёт разметку)
        st.linked = true; st.username = '<img src=x onerror=1>';
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#tgBox.ok #tgBody .tgn', { timeout: 5000 });
        check((await page.locator('#tgBody img').count()) === 0 && !/img/.test(await text('#tgBody .tgn')), 'имя не выводится, тега img нет');
        await noHScroll('привязан, длинное имя');

        // 10. 401 от /api/tglink: сессии нет, сайт открывается гостем
        st.auth = true;
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('#gBtn', { state: 'visible', timeout: 5000 });
        check(await page.locator('#mainNav').isVisible() && (await page.locator('#lf').count()) === 0, '401: гость, навигация видна, экрана входа нет');
        const csp = await page.evaluate(() => window.__csp);
        check(!csp.length, 'CSP: ' + csp.join('; '));
      } catch (e) { problems.push('сценарий: ' + e.message.split('\n')[0]); }
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${scheme.padEnd(5)} ${String(vp.width).padStart(4)} px  telegram: привязка${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      if (problems.length) fail();
      await ctx.close();
    }
  }
}
