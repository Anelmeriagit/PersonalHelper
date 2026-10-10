# Порядок деплоя по этапам (PowerShell; читать, когда нужно выложить или перевыложить этап)

## Порядок деплоя этапа 3b (PowerShell, из корня репозитория)
1. Распаковать zip поверх репозитория. Удалённые файлы zip не передаёт: `git rm cashback-spelling.patch`. По желанию `git rm tree.txt` (устаревший список файлов; в `.vercelignore` он уже есть, наружу не раздаётся).
2. По желанию локально: `node --import ./tests/register.mjs --test "tests/*.test.mjs"` (ожидается 300 из 300).
3. Настоящий Redis: `$env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; node tests/live-redis.mjs` (значения только в окне, в файлы не писать) → «Все проверки настоящего Redis пройдены». Пишет только ключи `selftest<время>:` и удаляет их.
4. Vercel → Settings → Environment Variables: заданы Redis-переменные, `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN`, `CRON_SECRET`. `AUTH_USER` пока оставить.
5. `git status` (нет ли лишних файлов, особенно с секретами) → `git add -A; git commit -m "Stage 3b part 5"; git push`. Деплой пойдёт сам. После зелёного деплоя: Vercel → Functions, должно быть 11 функций (лимит Hobby 12).
6. (Разовая чистка данных: скрипт `scripts/purge-3b.mjs` удалён из репозитория 2026-10-08; шаг не повторять, его `--apply` удалил бы документы кэшбэков всех аккаунтов.)
7. Сухой прогон cron: `$secret = '...'; curl.exe -H "Authorization: Bearer $secret" "https://<домен>/api/cron?dry=1"` → `"dry":true`, `would_send` 0, `errors` 0, `left` 0 (с этапа 5, части 3 `accounts` — число аккаунтов из индекса `dueq`, которым пора, а не всех привязанных).
8. Вебхук и меню бота: `curl.exe -H "Authorization: Bearer $secret" https://<домен>/api/tg-setup` → `"ok":true`, `url` оканчивается на `/api/telegram`.
9. Привязка Дениса и Жанны: вход на сайт → «Напоминания» → «Привязать Telegram» → «Открыть Telegram» → «Запустить». Если на сайте уже виден «@имя», привязывать заново не нужно: достаточно написать боту `/cashback`.
10. Проверка по спискам ниже (минимум: привязка, `/cashback`, ответ по магазину, напоминание на завтра после cron).
11. После вашего подтверждения, что всё работает: удалить `AUTH_USER` из Vercel (код её не читает, передеплой не нужен). `BLOB_READ_WRITE_TOKEN` и Blob-хранилище оставить до этапа 4.

## Порядок деплоя этапа 4.3 (резервная копия в cron)
1. Распаковать zip поверх репозитория, `npm i` (пакет `@vercel/blob` в `package.json`), по желанию тесты: `node --import ./tests/register.mjs --test "tests/*.test.mjs"` (ожидается 300 из 300).
2. Vercel → Storage: подключить Blob-хранилище к проекту (появится `BLOB_READ_WRITE_TOKEN`), доступ приватный.
3. Сгенерировать `BACKUP_KEY` (как `CRON_SECRET`; 64 hex-символа):
   `$b = New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); ($b | ForEach-Object { $_.ToString('x2') }) -join ''`
   Записать в менеджер паролей (без ключа копии не расшифровать), добавить в Vercel (Sensitive, Production).
4. По желанию до деплоя проверить настоящие базы: `node tests/live-redis.mjs` и `node tests/live-blob.mjs` (переменные в окне PowerShell, см. заголовки файлов).
5. `git add -A; git commit -m "Stage 4.3"; git push`, дождаться деплоя (11 функций, `vercel.json` не менялся).
6. Состояние без записи: `curl.exe -H "Authorization: Bearer $secret" "https://<домен>/api/cron?backup=1&dry=1"` → `"state":"on"`, `copies` 0, `due` true.
7. Первая копия вручную: `curl.exe -H "Authorization: Bearer $secret" "https://<домен>/api/cron?backup=1"` → `"state":"done"`, `keys` примерно как число ключей в Upstash. Если `partial`, повторить через минуту. Повторный `...?backup=1&dry=1` → `copies` 1, `due` false.
   Если `"state":"off"`: функция не видит `BACKUP_KEY`. Проверить по порядку: имя ровно `BACKUP_KEY`; отмечено окружение Production (деплой из ветки, не из Preview); переменная добавлена до деплоя (после добавления нужен Redeploy: Deployments → ⋯ → Redeploy); вы вызываете боевой адрес, а не адрес старого деплоя. Если `"state":"error","kind":"config"`: переменная есть, но значение негодное (не 64 hex-символа, лишние кавычки или пробелы, слишком простой ключ): создать заново и вставить без кавычек. Если в dry `"blob":false`: токен Blob не виден (подключить хранилище к проекту и сделать Redeploy).
8. Назавтра в журнале Vercel (Functions → `api/cron`) в 14:00 МСК должна быть строка без `backup failed`. (Это ожидание действовало до этапа 5, части 2, когда копия делалась раз в сутки; теперь копия раз в 7 суток, `skip` в остальные запуски, см. «Открыто» → «Резервная копия Redis».)

## Порядок деплоя: индекс dueq (этап 5, переход на внешний планировщик, часть 3; PowerShell, из корня репозитория)
1. Распаковать zip поверх репозитория; `git status` (нет ли лишнего) → `git add -A; git commit -m "Cron: due index"; git push`. Функций по-прежнему 11: новые файлы `api/_due.js`, `api/_reindex.js` с `_`.
2. Сразу после деплоя заполнить индекс (до этого `/api/cron` никого не находит). Значения только в окне PowerShell, в файлы не писать: `$env:KV_REST_API_URL='...'; $env:KV_REST_API_TOKEN='...'; $env:DB_PREFIX=''` (пусто = боевая база). Сухой прогон: `node scripts/fill-dueq.mjs`; затем `node scripts/fill-dueq.mjs --apply` (спросит ввод `REBUILD`).
3. Проверка: `$secret = '...'; curl.exe -H "Authorization: Bearer $secret" "https://<домен>/api/cron?role=backup&rebuild=1&dry=1"` → `rebuild.state:"ok"`, `add`/`change`/`drop` равны 0.
4. Частые внешние расписания (QStash, cron-job.org) включать только после этого (часть 4).

## Порядок деплоя этапа 5, части 3 (вход через Google; PowerShell, из корня репозитория)
Названия пунктов консоли Google написаны по памяти и могут отличаться: ориентир «OAuth consent screen» и «Credentials → OAuth client ID».
1. Консоль Google Cloud: создать проект (или взять имеющийся). «OAuth consent screen» (экран согласия): тип External, название, почта поддержки; области (scopes) только `openid` и `email`. Пока статус «Testing», войти смогут только добавленные тестовые пользователи; для всех нужно перевести приложение в «In production» (для этих областей проверка Google обычно не требуется).
2. «Credentials» → «Create credentials» → «OAuth client ID» → тип Web application. «Authorized redirect URIs»: ровно `https://<домен>/api/auth?action=google-cb` (без слеша в конце; для каждого домена отдельная строка, например и свой домен, и `*.vercel.app`, если входите и с него). «Authorized JavaScript origins» не нужны. Сохранить, взять Client ID и Client secret (секрет только в менеджер паролей и Vercel).
3. Vercel → Settings → Environment Variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (секрет отметить Sensitive; окружение Production), затем Redeploy (переменные подхватываются только новым деплоем).
4. Распаковать zip поверх репозитория; `git status` (нет ли лишнего, особенно с секретами) → `git add -A; git commit -m "Stage 5 part 3: Google sign-in"; git push`. Функций по-прежнему 11 (лимит Hobby 12): новых файлов в `api/` нет.
5. Проверка: приватное окно → «Войти через Google» → выбор почты → возврат на сайт, в шапке «Helper User»; «Настройки аккаунта» показывают почту и Account ID. Повторить выход и вход: тот же Account ID. Если после возврата сообщение «Вход через Google пока не настроен»: проверить имена переменных и Redeploy; «Не удалось войти»: журнал Vercel (Functions → `api/auth`, строка `auth google`); `redirect_uri_mismatch` на экране Google: адрес сайта не совпадает с внесённым в пункте 2.
