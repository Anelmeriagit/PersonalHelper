// Дымовая проверка интерфейса в Chromium (Playwright) с CSP из vercel.json и мок-API.
// Для каждой страницы × ширины 360/1280 × светлой/тёмной темы проверяет:
//   нет нарушений CSP, нет ошибок JS и console.error, нет обращений к незамоканному API,
//   нет горизонтальной прокрутки.
// Гостевой режим: сайт без входа, кэшбэк, WiFi и агент в браузере (--only=guest), выход и конец сессии (--only=session), слияние гостевых данных при входе в аккаунт (--only=merge), кэшбэк для одного человека (--only=cashback), личная сеть WiFi (--only=wifi),
// блок «Telegram» (--only=tg), вкладка «Напоминания» (--only=rem), аккаунт: Google, меню, настройки, удаление (--only=acct) и окно приветствия (--only=welcome), расход команд Redis: возврат на вкладку, опрос привязки, пауза сохранения (--only=refresh) проверяются отдельными сценариями.
// Во всех остальных сценариях флаг welcome=1 проставляется заранее, иначе окно приветствия перекрывало бы страницу.
// Запуск: node tests/smoke.mjs [--root=<папка>] [--only=guest|session|merge|cashback|wifi|tg|rem|acct|welcome|refresh]   (Playwright: npm i --no-save playwright && npx playwright install chromium)
// Устройство: этот файл поднимает стенд и браузер и по --only запускает сценарии; сами сценарии лежат рядом: smoke-pages.mjs (проход по страницам, без --only),
// smoke-guest.mjs, smoke-pair.mjs, smoke-session.mjs, smoke-merge.mjs, smoke-cashback.mjs, smoke-wifi.mjs, smoke-tg.mjs, smoke-rem.mjs, smoke-acct.mjs, smoke-welcome.mjs, smoke-refresh.mjs; общее — smoke-lib.mjs.
import path from 'node:path';
import { chromium } from 'playwright';
import { start } from './serve.mjs';
import { pages } from './smoke-pages.mjs';
import { guest } from './smoke-guest.mjs';
import { session } from './smoke-session.mjs';
import { merge } from './smoke-merge.mjs';
import { cashback } from './smoke-cashback.mjs';
import { wifi } from './smoke-wifi.mjs';
import { tg } from './smoke-tg.mjs';
import { rem } from './smoke-rem.mjs';
import { acct } from './smoke-acct.mjs';
import { pair } from './smoke-pair.mjs';
import { paircb } from './smoke-paircb.mjs';
import { welcome } from './smoke-welcome.mjs';
import { refresh } from './smoke-refresh.mjs';

const arg = process.argv.find((a) => a.startsWith('--root='));
const root = arg ? path.resolve(arg.slice(7)) : undefined;

const SCENARIOS = { guest, session, merge, cashback, wifi, tg, rem, acct, pair, paircb, welcome, refresh };
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
if (ONLY && !SCENARIOS[ONLY]) {
  console.error('Неизвестный сценарий --only=' + ONLY + '. Доступны: ' + Object.keys(SCENARIOS).join(', '));
  process.exit(2);
}

const stand = await start({ root });
console.log('CSP: ' + (stand.csp || 'НЕ НАЙДЕНА в vercel.json: проверка CSP не имеет смысла'));
const browser = await chromium.launch();
let failures = 0;
const env = { stand, browser, fail: () => { failures++; } };

if (!ONLY) await pages(env);
for (const name of Object.keys(SCENARIOS)) if (!ONLY || ONLY === name) await SCENARIOS[name](env);

await browser.close();
await stand.close();
console.log(failures ? `\nПровалено случаев: ${failures}` : '\nВсе случаи без замечаний');
process.exit(failures ? 1 : 0);
