# Personal Helper — заметки для Claude

Читать первым. Затем по индексу «Какие заметки читать» открывать только нужные файлы из `notes/`. После значимых правок: запись в «Журнал»; если изменились данные, API, карта модулей или ограничения — ещё и нужный файл в `notes/` или это ядро. Файлы из «Не просмотрено» перед правкой запрашивать.

## Что это
PWA «Personal Helper»: публичное мультипользовательское приложение. Вход один — через Google (кнопка в шапке), необязателен. Четыре раздела:
- **Кэшбэк** — какие категории выбраны в каком банке на текущий и следующий месяц, история прошлых месяцев, один человек на аккаунт; у соединённых аккаунтов третья колонка «Сравнение» (лучший процент каждого по категориям, `notes/cashback.md`).
- **Напоминания** — личные: «Повторяющиеся» (слева) и «Временные» (справа), у каждого вкл/выкл; рамки «Личные» и, у соединённых аккаунтов, «Общие». Блок «Telegram» над колонками привязывает аккаунт к боту @PersonalHelper1Bot, который шлёт напоминания и показывает кэшбэк. Только с аккаунтом.
- **Wi-Fi** — до 5 сетей: QR для камеры телефона, показ/копирование пароля, печать A4. У соединённых аккаунтов список общий (выбор «Оставить мою / партнёра / обе» при соединении).
- **Агент** — строки «приложение — время сброса токенов», порядок перетаскиванием, ближайший сброс подсвечен, в момент сброса уведомление браузера (пока сайт открыт). В Telegram не шлётся.

Режимы: **гость** (без входа: кэшбэк, агент, Wi-Fi в localStorage, `js/local.js`, на сервер ничего не уходит; напоминаний и бота нет; при первом входе гостевые данные сливаются в аккаунт, `js/merge.js`; `notes/guest.md`) и **аккаунт**. **Соединённые аккаунты**: по одноразовой ссылке `/?join=<токен>` два аккаунта видят кэшбэк друг друга только на просмотр, имеют общие напоминания (по галочке у каждого) и общий Wi-Fi; разрыв удаляет общие напоминания (`notes/account.md`). **Часовые пояса**: у каждого аккаунта свой (нет поля `tz` = Москва), у гостя пояс устройства; общие напоминания пары считаются по настенным часам каждого (`notes/reminders.md`, «Часовые пояса»).

Хостинг: Vercel, регион fra1, тариф **Hobby**: свой cron раз в сутки (`vercel.json`: `?role=backup&rebuild=1`), сервер сам не может отправить что-либо в точную минуту. Частые запуски `/api/cron` идут от внешних планировщиков (QStash, запасной cron-job.org; `notes/reminders.md`, `notes/DEPLOY.md`).

## Стек
- Фронтенд: статика без сборки. `index.html`, `style.css`, `theme.js`, `sw.js` и ES-модули в `js/` (вход `js/main.js`, `<script type="module">`; внутри ES5: `var`, `function`). HTML собирается строками в `innerHTML`, значения только через `esc()`.
- Бэкенд: Vercel Functions в `api/` (ESM, Node 22). Единственная зависимость `@vercel/blob` — только `api/_backup.js`. QR строит `api/_qr.js` (без пакетов); гостю — `js/qr.js`.
- Хранилище: Upstash Redis через REST (`api/_db.js`, CAS по версии). Ключи и расход команд — `notes/redis.md`. Blob — только приватные зашифрованные копии Redis (`notes/backup.md`), данные пользователей в Blob не пишутся.
- Бот: вебхук `api/telegram.js`, рассылка `api/cron.js`, логика и состояние `bot:<id>` в `api/_bot.js`, напоминания в `api/_rem.js`, словарь магазинов `api/_shops.js`, разовая настройка вебхука `api/tg-setup.js`. Токен в `TELEGRAM_BOT_TOKEN`, имя бота в коде не хранится (`getMe`), команды в `BOT_COMMANDS` (`_bot.js`, применяются вызовом `tg-setup`).

## Ограничения (важно при правках)
- CSP в `vercel.json`: нет inline-скриптов и inline-обработчиков, нет внешних скриптов и стилей; inline-атрибуты `style` разрешены; картинки только свои и `data:`.
- Без сборщика и фреймворков. Новые стили — в конец `style.css`, на существующих классах.
- Репозиторий публичный: в коде, заметках и тестах только имена переменных окружения, без значений секретов, паролей, токенов, ключей шифрования и хешей. Секреты только в переменных Vercel (список имён — `notes/CHECKLIST.md`).
- Написание: в видимых текстах «кэшбэк» (в идентификаторах `cashback`) и «Wi-Fi» (не «WiFi»); идентификаторы, адреса и `WIFI:` в QR-строке не менять.
- Данные пользователей пишутся только через `writeDoc` (кэшбэк), `writeRec`/`dropRec` (агент `agent:<id>`, Wi-Fi `wifi:<id>`), `mutateRem` (`rem:<id>`), `mutateShr` (общие напоминания `shr:…`, только после `partnerAcc`), `api/wifi.js` (общий Wi-Fi `wfs:…`, только после `partnerAcc`; копия при разрыве — `unpair` в `api/_acc.js`), `mutateBot` (`bot:<id>`) и функции `api/_acc.js`. Мимо `normBot`/`normRem` не писать, иначе теряются поля. Новое поле: бота — в `normBot` (`_bot.js`); напоминаний — в `custom1`/`rec1`/`normRem`; общих — в `scustom1`/`srec1`/`normShr` (`_rem.js`).
- Расход команд Redis (Upstash Free) — читать `notes/redis.md` перед правкой, добавляющей запросы.
- Hobby: не больше 12 функций в `api/`; сейчас 11 (файлы без `_`: `data`, `reminders`, `custom`, `recurring`, `agent`, `wifi`, `cron`, `telegram`, `tg-setup`, `auth`, `tglink`). Вспомогательные модули называть с `_`. Одноимённые файлы в `api/` и `js/` (`tglink.js`, `wifi.js`) — разные файлы.
- Скрипты (`scripts/`, не функции, исключены в `.vercelignore`): удаляющие или перезаписывающие данные идут сухим прогоном по умолчанию, `--apply` с вводом `DELETE`, в выводе только числа и начало id; образец — `scripts/restore-backup.mjs`, общее — `scripts/_cli.mjs`. Скрипты запускать с тем же `DB_PREFIX`, что на сайте.
- Заглушка Blob в `tests/` (`blob.mjs`, `hooks.mjs`) постоянная: на ней держатся код копии и скрипт восстановления.

## Парные правила (править обе части синхронно)
- **Формат кэшбэка** (`months: {YYYY-MM: [блоки]}`): сайт (блоки банков `colHtml` и колонка «Сравнение» `vsHtml` в `js/cashback/view.js`, компактного вида и подсветки в блоках нет) и бот (`_bot.js`: `filledRows`, `catRows`, `pctLines`, `monthText`, `cashbackTexts`; ответ по магазину `shopText` использует `pctLines`). Кэшбэк партнёра в боте — только просмотр, подпись «Имя: процент — банк» (`pr` в `catRows`/`pctLines`, `loadView` в `telegram.js`), отдельная разметка от сайта: менять смысл подписей вместе. Читать документ партнёра только через `partnerAcc`/`partnerOf`, писать только свой. `notes/cashback.md`.
- **Гостевой кэшбэк**: `js/local.js` (`clean`, `cleanCustom`, `cleanBlocks`, окно месяцев, версии частей, `mergeCb`, `mergeAg`) зеркалит `api/_lib.js` (`clean`, `cleanCustom`, `cleanBlocks`, `PART_RE`) и `api/data.js` (PUT). Справочники `BANKS`, `CATS`, `PCTS` на сайте и сервере одинаковы; `BANK_NAMES` в `api/_bot.js` и `logos/<id>.svg` идут той же парой.
- **Гостевой агент и Wi-Fi**: `js/local.js` (`cleanApp`, `cleanRows`, `withAt`, `nextAt`, лимит 12 строк; `cleanWifi`, `normNets`, `wifiString`, до 5 сетей) зеркалит `api/agent.js` и `api/wifi.js`; `js/qr.js` — копия `api/_qr.js` в ES5 (результат до бита тот же). Пароль Wi-Fi гостя на сервер не уходит.
- **Часовые пояса**: `js/tz.js` ↔ `api/_tz.js` (плюс `nextAt`, `retimeRows` ↔ `api/agent.js`, `monthWindow` ↔ `api/_lib.js`; ES5, результат тот же); гостевой `withAt` в `js/local.js` ↔ `api/agent.js` (у сервера пояс — необязательный последний параметр, по умолчанию Москва). Месяц «сейчас» на сервере — `curMonth(tz)` или `nowIn(tz).month`, для окна без пояса — `monthWindow()`. Кода с зашитой Москвой не писать: `nowIn(tz)`, `zonedToMs(…, tz)`.

## Карта файлов
**Корень:** `index.html`, `style.css`, `theme.js` (тема без мигания), `sw.js` (только уведомления, ничего не кеширует), `manifest.webmanifest`, `vercel.json`, `.vercelignore` (заметки, `tests/`, `scripts/` не раздавать и не деплоить), `.gitignore` (в том числе `*.zip`, `*.patch`, `exports/`).
**Служебное:** `tests/` (одна папка; `notes/tests.md`), `scripts/` (`restore-backup.mjs`, `fill-dueq.mjs` — заполнение и перестройка `dueq`, `export-shops.mjs` — выгрузка новых магазинов из псевдонимов бота в `exports/`, `_cli.mjs`), `notes/`.

**api/:**
- `_db.js` (Redis REST, CAS, замок), `_acc.js` (аккаунты, Google `googleAccount`, лимиты, `setTz`, связь пар: `partnerOf`, `partnerAcc`, `createPairToken`, `joinPair`, `unpair`), `_lib.js` (`clean`, `curMonth`, `monthWindow`, `readDoc/loadDoc/writeDoc`, `readRec/writeRec/dropRec`, сессия), `_tz.js` (пояса без Redis), `_rem.js` (личные и общие напоминания: `mutateRem`, `mutateShr`, `planRem`, `planShr`, `nextDueRem`, `nextDueShr`, `whenErr`), `_due.js` (индекс `dueq`), `_reindex.js` (`rebuildDue`, `reindexAccount`), `_bot.js`, `_shops.js`, `_qr.js`, `_backup.js` (копия Redis: обход, AES-256-GCM по `BACKUP_KEY`, Blob, ротация 7, `KNOWN`/`TEMP`, команды восстановления).
- Эндпоинты: `auth.js` (выход; `me`, `rename`, `set-tz`, `delete`, `pair-link`, `pair-join`, `pair-drop`, `pair-wifi`; вход Google `google`/`google-cb` обычными GET), `data.js`, `reminders.js`, `custom.js`, `recurring.js`, `agent.js`, `wifi.js`, `cron.js`, `telegram.js`, `tg-setup.js`, `tglink.js` (GET статус, POST ссылка, DELETE отвязать).

**js/:**
- `main.js` — каркас: `boot()` (запрос `GET /api/data`: 401 — гость, 200 — аккаунт), `openAcct` (слияние гостя один раз на аккаунт и браузер), `logout`, `toGuestMode(snap, notice)`, страницы по hash (`#reminders`, `#wifi`, `#agent`), `?gerr=`, `?join=` (`joinStore`, `joinTry`, ключ `pj`). Вызывает `init*` и `boot()`.
- `util.js` (`$`, `esc`, `opts`, иконки `IC`…), `time.js` (пояс режима `useTz`, `curTz`), `tz.js`, `tzlist.js` (список поясов), `tzhint.js` (смена пояса, подсказка о расхождении с устройством), `api.js` (`api()`, `net()`, состояние `S`, `REFRESH_MS`, `fresh`/`stamp`, `authFail`), `dialogs.js`.
- `local.js` (гостевой «сервер в браузере»: `guestApi`, ключи `g-cb`, `g-ag`, `g-wf`, `g-mg`), `merge.js`, `qr.js`.
- `cashback/` (`state`, `view`, `index`), `reminders/` (`state`, `index`, `lists`), `agent/` (`state`, `index`, `notify`, `drag`), `wifi.js`, `account.js` (меню `#uBtn`/`#navAcct`, «Настройки аккаунта» `#acctDlg`, удаление `#delDlg`, `#gBtn`), `welcome.js`, `theme-switch.js`, `tglink.js` (блок «Telegram»).
- Правила модулей: не импортировать `main.js`; о 401 сообщать через `authFail()`; `reminders/lists.js` обновляет карточки через `R.sync()`/`R.load()`; при импорте модули ничего не вешают, слушатели ставят только `init*`.

## Решения владельца (не переспрашивать)
- Разделы: Кэшбэк, Напоминания, Wi-Fi, Агент; справочник банков `BANKS` — 13 банков, менять только по просьбе.
- Напоминания личные, привязаны к аккаунту; у пары добавляются общие. Бот только у аккаунтов с привязанным Telegram.
- Боевой `DB_PREFIX` — `t:`. Внешний мониторинг ошибок cron не нужен: хватает журнала Vercel и кода ответа 502.
- Отложено, пока владелец не скажет «продолжай»: проверка недельных копий cron и интерфейса аккаунта на боевом сайте (`notes/CHECKLIST.md`).

## Какие заметки читать
- Кэшбэк, история, сообщение бота `/cashback`, ответ по магазину, обучение бота, выгрузка магазинов → `notes/cashback.md`
- Напоминания (в том числе общие), cron, Telegram, состояние бота, часовые пояса, `dueq`, лимиты Upstash → `notes/reminders.md`
- Агент, уведомления браузера → `notes/agent.md`
- Wi-Fi, QR, печать, общий Wi-Fi → `notes/wifi.md`
- Меню, настройки, вход через Google, удаление, соединение аккаунтов, окно приветствия, окно выбора пояса → `notes/account.md`
- Гостевой режим, слияние, выход и конец сессии → `notes/guest.md`
- Вход, сессия, cookie, лимиты, ключи привязки Telegram → `notes/session.md`
- Ключи Redis, расход команд → `notes/redis.md`
- Резервная копия, `BACKUP_KEY`, Blob → `notes/backup.md`
- Как проверять, какие тесты просить, концы строк → `notes/tests.md`
- Деплой, расписания → `notes/DEPLOY.md`
- Переменные Vercel, служебные вызовы, что осталось проверить → `notes/CHECKLIST.md`
- Что подтверждено владельцем → `notes/VERIFIED.md` (по умолчанию не читать)
- Правка затрагивает несколько разделов → читать каждый из них. История решений — `git log`.

## Не просмотрено
Построчно на секреты не читались: `api/auth.js`, `api/_lib.js`, `api/data.js`, `api/wifi.js`, `api/agent.js`, `js/main.js`, `js/wifi.js`. 2026-10-13 по ним прошёл поиск по шаблонам (длинные hex и base64, токены Telegram, идентификаторы Google, строки вида `ключ = '…'`, адреса) и список строк с `console.*`, `process.env`, `localStorage`: значений секретов нет, в журнал секреты не пишутся. Остаётся замечание: `api/data.js` в `catch` пишет в журнал объект ошибки целиком (`console.error(e)`), остальные файлы — только `e.name`.

## Как работать
- Перед задачей: прочитать это ядро и нужные заметки, назвать нужные файлы кода (кратко, не весь репозиторий).
- Окружение владельца: Windows PowerShell (`Select-String -Encoding utf8` вместо `grep`, `curl.exe` вместо `curl`); браузер и Playwright он не ставит, интерфейс проверяет Claude в песочнице (`notes/tests.md`); ему остаются коммит и деплой (через GitHub Desktop, не командами git), Vercel, боевой сайт и телефоны, Upstash, Telegram, `scripts/` и `tests/live-*.mjs`.
- В репозиторий и на деплой попадают только файлы проекта; архивы, патчи, выгрузки, логи и временные файлы — нет. Лишнее в присланном репозитории — назвать в начале и перечислить файлы к удалению (владелец удаляет их в папке, GitHub Desktop покажет).
- Журнал: до трёх строк (дата, что изменено, файлы; «не проверялось», если важно после деплоя), хранятся последние 5, остальное — в `git log`. Непроверенное — в `notes/CHECKLIST.md`.

## Журнал (последние 5; новые записи в конец)
- 2026-10-13: у соединённых аккаунтов в кэшбэке третья колонка «Сравнение» (лучший процент у каждого, `best`/`dim`); компактный вид, переключатель `#vsw` и подсветка в блоках убраны: `js/cashback/{state,view,index}.js`, `index.html`, `style.css`, `tests/smoke-{paircmp,paircb,cashback}.mjs`, `tests/smoke.mjs`; `notes/cashback.md`, `notes/tests.md`, `notes/CHECKLIST.md`. Не проверялось: телефон и боевой сайт.
- 2026-10-14: закрыт пункт «Новые банки» (по словам владельца): `notes/CHECKLIST.md` → `notes/VERIFIED.md`.
- 2026-10-14: блок «Telegram» на «Напоминаниях»: `wait` в разметке (не мигает большим), заголовок и текст по центру, нет пустого места под кнопкой, предупреждение `#remWarn` той же ширины и по центру: `index.html`, конец `style.css`, `tests/smoke-tg.mjs`; `notes/reminders.md`, `notes/CHECKLIST.md`, `notes/VERIFIED.md`. Не проверялось: телефон и боевой сайт.
- 2026-10-14: закрыт пункт «Блок Telegram» (вёрстка подтверждена владельцем); записано, что коммит и деплой владелец делает через GitHub Desktop: `PROJECT_NOTES.md`, `notes/DEPLOY.md`, `notes/CHECKLIST.md`, `notes/VERIFIED.md`.
- 2026-10-14: концы строк: добавлен `.gitattributes` (`* text=auto eol=lf`), девять файлов с CRLF переведены в LF (в репозитории они и так были LF), `.gitattributes` в `.vercelignore`: `.gitattributes`, `.vercelignore`, `notes/tests.md`. GitHub Desktop без предупреждения (по словам владельца).
