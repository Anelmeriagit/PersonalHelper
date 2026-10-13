# Деплой и настройка окружения (PowerShell, из корня репозитория; читать, когда нужно выложить проект, подключить сервис или перенастроить расписание)

Названия пунктов консолей Vercel, Google, Upstash и cron-job.org написаны по памяти и могут отличаться; что не проверено, записано в `notes/CHECKLIST.md`. Значения секретов только в окне PowerShell и в полях сервисов, в файлы не писать. Переменные окружения — таблица в `notes/CHECKLIST.md`; `$secret` в служебных вызовах задавать заново в каждом окне.

## 1. Обычная выкладка
1. Распаковать присланный архив поверх репозитория. Удаления архив не передаёт: `git rm …` из ответа.
2. `git status` (нет ли лишнего, особенно с секретами) → `git add -A; git commit -m "<что сделано>"; git push`. Деплой пойдёт сам; после него `Ctrl+F5` на сайте.
3. Vercel → Functions: 11 функций (лимит Hobby 12); файлы `api/_*.js` в счёт не идут. Vercel → Settings → Cron Jobs: один вызов `/api/cron?role=backup&rebuild=1`, `0 15 * * *`.
4. Сухой прогон cron: `curl.exe -H "Authorization: Bearer $secret" "https://<домен>/api/cron?dry=1"` → `"dry":true`, `errors` 0, `left` 0 (`would_send` 0, если слать нечего; `accounts` — аккаунты из индекса `dueq`, которым пора, а не все привязанные).
5. Перед выкладкой по желанию на настоящем Redis: `$env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; node tests/live-redis.mjs` (и `tests/live-blob.mjs`, переменные в заголовках файлов); пишет только ключи `selftest<время>:` и удаляет их.

## 2. Первичная настройка (новый проект Vercel или новая база)
1. Переменные в Vercel (Settings → Environment Variables, Production): Redis (`KV_REST_API_URL`, `KV_REST_API_TOKEN`), `DB_PREFIX`, `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN`, `CRON_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BACKUP_KEY`; `BLOB_READ_WRITE_TOKEN` появляется при подключении Blob. После добавления или смены переменной нужен Redeploy (Deployments → ⋯ → Redeploy).
2. **Вебхук и меню бота:** `curl.exe -H "Authorization: Bearer $secret" https://<домен>/api/tg-setup` → `"ok":true`, `url` оканчивается на `/api/telegram`. Привязка человека: сайт → «Напоминания» → «Привязать Telegram» → «Открыть Telegram» → «Запустить»; затем бот отвечает на `/cashback`. Смена бота — `notes/reminders.md`, «Безопасность бота».
3. **Вход через Google.** Консоль Google Cloud: проект; «OAuth consent screen»: тип External, название, почта поддержки, области только `openid` и `email`; пока статус «Testing», войти могут только добавленные тестовые пользователи, для всех нужен «In production» (для этих областей проверка обычно не нужна). «Credentials» → «Create credentials» → «OAuth client ID» → Web application; «Authorized redirect URIs»: ровно `https://<домен>/api/auth?action=google-cb` (без слеша в конце; отдельная строка на каждый домен, например и свой, и `*.vercel.app`); «Authorized JavaScript origins» не нужны. Client ID и secret — в Vercel (секрет Sensitive) и менеджер паролей, затем Redeploy.
   Проверка: приватное окно → «Войти через Google» → возврат на сайт; «Настройки аккаунта» показывают почту и Account ID; повторный вход даёт тот же Account ID. «Вход через Google пока не настроен» — имена переменных и Redeploy; «Не удалось войти» — журнал Vercel (Functions → `api/auth`, строка `auth google`); `redirect_uri_mismatch` — адрес сайта не совпадает с внесённым.
4. **Резервная копия.** Vercel → Storage: подключить Blob (приватный доступ). `BACKUP_KEY` — 64 hex-символа, записать в менеджер паролей (без ключа копию не расшифровать), в Vercel как Sensitive:
   `$b = New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''`
   Состояние без записи: `…/api/cron?backup=1&dry=1` → `"state":"on"`, `copies` 0, `due` true. Первая копия вручную: `…/api/cron?backup=1` → `"state":"done"`, `keys` примерно как число ключей в Upstash (`partial` — повторить через минуту); повторный `dry` → `copies` 1, `due` false. Копия идёт раз в 7 суток, в остальные запуски `skip` (`notes/backup.md`).
   Если `"state":"off"`: функция не видит `BACKUP_KEY` — имя ровно `BACKUP_KEY`, отмечено Production, добавлено до деплоя или сделан Redeploy, вызывается боевой адрес. Если `"state":"error","kind":"config"`: значение негодное (не 64 hex, кавычки или пробелы) — создать заново без кавычек. Если в dry `"blob":false`: токен Blob не виден — подключить хранилище к проекту и Redeploy.
5. **Индекс `dueq`** (до включения внешних расписаний: без него `/api/cron` никого не находит): `$env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; $env:DB_PREFIX='t:'` (то же значение, что в Vercel; пустой префикс — другая, пустая база). Сухой прогон `node scripts/fill-dueq.mjs`, затем `node scripts/fill-dueq.mjs --apply` (ввод `REBUILD`). Проверка: `…/api/cron?role=backup&rebuild=1&dry=1` → `rebuild.state:"ok"`, `add`/`change`/`drop` равны 0.

## 3. Внешние расписания (устройство и расчёт — `notes/reminders.md`, «Расписания и деплой», «Лимиты Upstash»)
1. **Проверка до включения:** `…/api/cron?dry=1` → `role:"primary"`, `errors:0`, `left:0`.
2. **QStash** (консоль Upstash → QStash → Schedules): адрес `https://<домен>/api/cron`; cron `*/10 * * * *` (круглые сутки, UTC; `CRON_TZ` не использовать); заголовок `Upstash-Forward-Authorization` со значением `Bearer <CRON_SECRET>`; метод любой. Расписание должно остаться одно. Лимиты бесплатного плана сверить на странице тарифов (нужно одно расписание и 144 сообщения в сутки). Первый запуск («Trigger») даёт 200; 401 — заголовок не дошёл как `Authorization`.
3. **Проверка после первого запуска:** `…/api/cron?dry=1` → `last` не старше 10 минут, `took_over:false`; `…/api/cron?role=backup` → `skipped:"primary alive"` (без `dry`: запасной при живом основном ничего не делает). В Upstash Data Browser виден `cron:hb`. Ночью (00:00–06:50 по Москве) в журнале QStash должны быть запуски с ответом 200.
4. **cron-job.org** (задание): адрес `https://<домен>/api/cron?role=backup`; GET; в :05 и :35 каждого часа круглые сутки (чтобы не сталкиваться с QStash); часовой пояс сервиса UTC; заголовок `Authorization: Bearer <CRON_SECRET>`; первый запуск в истории 200.
5. **Отказ основного** (по желанию, на тестовом напоминании на ближайший час): приостановить QStash больше чем на 15 минут → запуск cron-job.org отвечает `took_over:true` и рассылает; возобновить QStash.
6. Через 2–3 дня сверить в консоли Upstash суточное число команд с расчётом (`notes/redis.md`, `notes/reminders.md`, «Лимиты Upstash») и при необходимости изменить `MAX_USERS`.

## 4. Проверка двух часовых поясов на боевом сайте
Телефоны или два окна браузера; пояс потом вернуть. Для ночного окна лучше восточный пояс (Токио, UTC+9).
- У аккаунта Б: «Настройки аккаунта» → «Часовой пояс» → другой пояс. Подзаголовок «Напоминаний» показывает новый пояс; строка агента «10:00» сместилась, «через … мин» прежнее.
- Общее напоминание (у обоих привязан Telegram) на ближайший будущий слот по часам обоих (`whenErr`): каждому приходит в HH:MM по его часам.
- Личное на Б с утренним слотом по поясу Б, ночным по Москве (завтра «после 07:00» в Токио = 01:00 по Москве): приходит ночью по Москве.
- Пока не ушло, сухой прогон на дату: `…/api/cron?dry=1&date=ГГГГ-ММ-ДД` → `would_send` считает каждого по его настенной дате.
- Вернуть пояс обоих в Москву и убедиться, что «10:00» в агенте снова 10:00.
