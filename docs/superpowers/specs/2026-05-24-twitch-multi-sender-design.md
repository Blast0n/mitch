# Twitch Multi-Sender — Design

**Дата:** 2026-05-24
**Статус:** Утверждено к реализации

## 1. Цель

Веб-приложение для рассылки одинакового сообщения от N принадлежащих пользователю Twitch-аккаунтов в указанный канал. Запуск на VPS, доступ через браузер с одного пароля. Поддержка SOCKS5-прокси с группировкой «N аккаунтов на 1 прокси». Растяжка отправки во времени для имитации естественного потока. Изначальный объём — 5 аккаунтов, целевой — до ~100.

**Замечание про ToS Twitch:** массовая рассылка из нескольких аккаунтов в собственный чат формально нарушает Terms of Service (искусственная активность). Риск — бан аккаунтов. Пользователь информирован.

## 2. Функциональные требования

1. Хранить список аккаунтов (логин + OAuth-токен `chat:edit`).
2. Хранить список SOCKS5-прокси (host, port, опционально username/password).
3. Хранить общие настройки: канал-получатель, текст сообщения, `accountsPerProxy`, `spreadSeconds`, `concurrency`.
4. По нажатию одной кнопки запустить отправку: каждый аккаунт пишет сообщение в чат канала через назначенный ему прокси.
5. Аккаунт→прокси по правилу `proxies[ floor(i / accountsPerProxy) mod proxies.length ]`. При нехватке прокси список циклится. При пустом списке прокси — отправка напрямую.
6. Растянуть отправку: интервал между аккаунтами = `spreadSeconds / accounts.length`. Конкурентность ограничена `concurrency`.
7. В UI — стрим прогресса в реальном времени (по аккаунту: `pending → sending → ok|failed` + текст ошибки).
8. Возможность повторить только упавшие аккаунты.
9. CRUD для аккаунтов, прокси, настроек через web UI.
10. Авторизация пользователя одним паролем; cookie-сессия на N дней.

## 3. Нефункциональные требования

- **Стек:** Node.js (LTS), Express, `ws`, `socks-proxy-agent`, `bcrypt`, `cookie-signature`, `express-rate-limit`, `p-limit`, `dotenv`.
- **Без БД, без билд-степа фронта.** Vanilla HTML + JS.
- **Хранение:** атомарная запись JSON-файлов в `./data/`.
- **TLS:** Caddy reverse-proxy на VPS (автоматический Let's Encrypt).
- **Процесс-менеджер:** systemd unit.
- **Зависимостей минимум.** Не использовать tmi.js (плохая поддержка прокси).

## 4. Архитектура

```
[Browser] --HTTPS--> [Caddy :443] --HTTP--> [Node :3000] --WSS via SOCKS5--> [Twitch IRC]
                                                  |
                                                  +-- ./data/*.json (atomic write)
                                                  +-- ./.env (password hash, secrets)
```

Монолит. Один процесс, состояние job'а — in-memory, сбрасывается при рестарте.

## 5. Структура проекта

```
project/
├── server.js              // Express bootstrap, монтаж роутов, SSE-хаб
├── auth.js                // middleware, /login, /logout, bcrypt + HMAC cookie
├── store.js               // read/write data/*.json, валидация
├── twitch.js              // sendOne(account, proxy, channel, word) → result
├── sender.js              // оркестратор: распределение, таймеры, concurrency, события
├── routes/
│   ├── api.js             // POST /api/send, GET /api/progress (SSE), CRUD
│   └── pages.js           // GET / /settings /accounts /proxies /login
├── public/
│   ├── app.js             // fetch + EventSource, таблицы
│   └── style.css
├── views/                 // HTML-шаблоны (template literals, без отдельного движка)
├── data/                  // gitignored, создаётся при первом старте
│   ├── accounts.json
│   ├── proxies.json
│   └── settings.json
├── test/                  // node:test
├── .env                   // APP_PASSWORD_HASH, SESSION_SECRET, PORT, COOKIE_DAYS
├── .env.example
├── .gitignore             // data/, .env, node_modules/
├── package.json
├── Caddyfile.example
└── systemd/
    └── twitch-sender.service
```

## 6. Модель данных

### `data/accounts.json`
```json
[
  { "login": "user1", "oauthToken": "oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
  { "login": "user2", "oauthToken": "oauth:yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy" }
]
```

### `data/proxies.json`
```json
[
  { "host": "1.2.3.4", "port": 1080, "username": "u", "password": "p" },
  { "host": "5.6.7.8", "port": 1080 }
]
```
Поля `username`/`password` опциональны.

### `data/settings.json`
```json
{
  "channel": "mychannel",
  "word": "hello",
  "accountsPerProxy": 5,
  "spreadSeconds": 300,
  "concurrency": 10
}
```

### Дефолты при первом запуске
- `accounts.json` → `[]`
- `proxies.json` → `[]`
- `settings.json` → `{channel:"", word:"", accountsPerProxy:5, spreadSeconds:0, concurrency:5}`

## 7. Ключевые модули

### `twitch.js`
Pure-функция:
```
sendOne(account, proxy | null, channel, word) → Promise<{ok: boolean, error?: string, durationMs: number}>
```
Что делает:
1. Открывает WebSocket к `wss://irc-ws.chat.twitch.tv:443`. Если `proxy != null` — через `SocksProxyAgent`.
2. Шлёт `PASS <oauthToken>` / `NICK <login>` / `JOIN #<channel>` / `PRIVMSG #<channel> :<word>`.
3. Слушает ответы. Отвечает PONG на PING.
4. Распознаёт ошибки:
   - `:tmi.twitch.tv NOTICE * :Login authentication failed` → `token_invalid`
   - `:tmi.twitch.tv NOTICE #ch :...` после `JOIN` → `join_failed`
   - Прочие NOTICE с негативным содержимым в течение 3 сек после `PRIVMSG` → `account_blocked`
5. Если 3 сек после `PRIVMSG` без негативного NOTICE — `{ok:true}`.
6. Общий таймаут 15 сек → force-close, `{ok:false, error:"timeout"}`.
7. Никогда не throw'ит наружу — все ошибки превращаются в `{ok:false, error}`.

### `sender.js`
Управляет одним job'ом за раз. Singleton состояния:
```js
let currentJob = null  // или {jobId, accounts, proxies, settings, results: [], status, listeners: Set<emit>}
```
API:
- `start({accounts, proxies, settings}) → {jobId}` — бросает `JobAlreadyRunning` если есть активный.
- `subscribe(jobId, listener)` — для SSE.
- `getSnapshot(jobId)` — текущий список результатов (для re-connect SSE).

Логика старта:
```
interval = (spreadSeconds * 1000) / accounts.length    // 0 если spreadSeconds=0
для i от 0 до accounts.length - 1:
   proxy = proxies.length ? proxies[ floor(i / accountsPerProxy) mod proxies.length ] : null
   setTimeout(() => queue.add(() => run(account[i], proxy)), i * interval)

queue: p-limit или своя реализация с concurrency = settings.concurrency

run(account, proxy):
   emit({type:'sending', login: account.login})
   result = await twitch.sendOne(account, proxy, settings.channel, settings.word)
   currentJob.results.push({login, ...result, proxy: proxy ? `${proxy.host}:${proxy.port}` : 'direct'})
   emit({type:'progress', login, result})
   если все аккаунты обработаны: emit({type:'done', summary}), запустить таймер на очистку (5 мин)
```

### `store.js`
- `read(name) → object`. Если файл отсутствует — вернуть дефолт. Если битый JSON — throw `StoreCorrupt`.
- `write(name, obj)` — `fs.writeFile(name + '.tmp')` → `fs.rename` (атомарно на POSIX).
- Валидация через ручные функции (не тащим zod, если не нужно): `validateAccounts(arr)`, `validateProxies(arr)`, `validateSettings(obj)`. Возвращают список строк-ошибок или `[]`.

### `auth.js`
- `hash(plain) → bcryptHash` (для миграции/первичной установки в README).
- `middleware(req, res, next)`:
  - читает cookie `sid`;
  - валидирует HMAC + проверяет срок;
  - если ок — `next()`; если нет — для HTML-роутов redirect `/login`, для API — 401 JSON.
- `POST /login`: `bcrypt.compare`, при успехе — выставить cookie `sid=HMAC(timestamp).timestamp` с `httpOnly; Secure; SameSite=Strict; Max-Age=COOKIE_DAYS*86400`.
- `GET /logout`: очистить cookie, redirect `/login`.
- Rate-limit на `/login`: 5 попыток в 15 минут по IP (`express-rate-limit`).

## 8. HTTP API

| Метод | Путь | Auth | Описание |
|---|---|---|---|
| GET | `/` | да | главная: статус, кнопка отправки |
| GET | `/login` | нет | форма пароля |
| POST | `/login` | нет | проверка пароля |
| GET | `/logout` | да | выйти |
| GET | `/accounts` | да | страница CRUD аккаунтов |
| GET | `/proxies` | да | страница CRUD прокси |
| GET | `/settings` | да | страница CRUD настроек |
| GET | `/api/accounts` | да | вернуть массив |
| PUT | `/api/accounts` | да | заменить целиком, тело — массив |
| GET | `/api/proxies` | да | вернуть массив |
| PUT | `/api/proxies` | да | заменить целиком |
| GET | `/api/settings` | да | вернуть объект |
| PUT | `/api/settings` | да | заменить объект |
| POST | `/api/send` | да | стартовать job; 202 `{jobId}` или 409 если уже идёт |
| POST | `/api/send/retry-failed` | да | новый job только с упавшими из последнего |
| GET | `/api/progress?jobId=...` | да | **SSE** stream событий job'а |

**Формат SSE-событий:**
```
event: progress
data: {"login":"user1","status":"ok","durationMs":820,"proxy":"1.2.3.4:1080"}

event: done
data: {"jobId":"...","total":100,"ok":97,"failed":3}
```

## 9. UI

Четыре страницы: `/`, `/accounts`, `/proxies`, `/settings`, плюс `/login`.

### `/` — Главная
- Текущие настройки (channel, word, accountsPerProxy, spreadSeconds, concurrency) в read-only виде с ссылкой «изменить».
- Сводка: «N аккаунтов, M прокси, ETA: X секунд».
- Большая кнопка **«Отправить»**. Disabled если accounts пуст, channel/word пустые, или уже идёт job.
- Под кнопкой — таблица прогресса (login, статус, прокси, длительность, ошибка). Обновляется по SSE.
- После завершения job'а — кнопка «Повторить упавшие» (видна только если есть failed).

### `/accounts`
Табличный редактор:
- Колонки: `login`, `oauthToken` (показывается замаскированно `oauth:****...****` с кнопкой «показать»).
- Кнопки: «Добавить строку», «Удалить», «Импорт из текста» (paste TSV/CSV: `login<TAB>token`).
- «Сохранить» → `PUT /api/accounts`.
- Валидация: непустой login (только `[a-zA-Z0-9_]`), токен начинается с `oauth:` и имеет длину >= 30.

### `/proxies`
Аналогично:
- Колонки: `host`, `port`, `username`, `password`.
- «Импорт из текста»: `host:port` или `host:port:user:pass`.
- Валидация: непустой host, port 1–65535.

### `/settings`
Простая форма.

## 10. Безопасность

- Пароль приложения хранится только хэшем (bcrypt, cost 12) в `APP_PASSWORD_HASH`.
- `SESSION_SECRET` (random 32 байт hex) для HMAC cookie.
- Cookie: `httpOnly; Secure; SameSite=Strict`. **Secure обязателен** — приложение только через HTTPS.
- `data/*.json` под `chmod 600` (Node должен бежать от выделенного юзера на VPS).
- Токены не логируются. В логах — только `login` и тип ошибки.
- Rate-limit на `/login` (5/15min/IP).
- CSRF: SameSite=Strict cookie + проверка `Origin`/`Referer` на POST/PUT (отдельный мини-middleware).
- В `.gitignore`: `data/`, `.env`, `node_modules/`.

## 11. Обработка ошибок

См. таблицу в секции «Дизайн». Ключевые принципы:
- `twitch.sendOne` всегда возвращает результат, никогда не throw'ит.
- Падения отдельных аккаунтов не останавливают job.
- Пустой список прокси разрешён (шлём напрямую).
- Состояние job'а только в памяти, не переживает рестарт процесса.
- Авто-refresh OAuth-токенов вне scope.
- Авто-замена мёртвых прокси вне scope.

## 12. Тестирование

Раннер — `node:test` (встроенный).

**Unit-тесты:**
- `store.js` — дефолты, атомарность, валидация.
- `auth.js` — bcrypt, HMAC cookie, middleware, истечение.
- `sender.js` — распределение, циклинг прокси, concurrency-лимит, spread-задержки (фейк-таймеры), пустые списки.
- `twitch.js` — парсинг IRC-строк, генерация команд, распознавание ошибочных NOTICE. Сетевые операции абстрагированы за интерфейс, мокаются.

**Integration:**
- HTTP-тесты через `supertest`: 401 без логина, полный цикл login→PUT→send→SSE, 409 при двойном send. `twitch.sendOne` замокан.

**Manual smoke (`docs/smoke.md`):**
- Тестовый аккаунт без прокси → видим сообщение.
- Тестовый аккаунт через прокси → IP в логах совпадает.
- Протухший токен → понятная ошибка.
- Мёртвый прокси → `proxy_unreachable` за ≤10 сек.
- 5 реальных аккаунтов, spread=60s → все доходят, прогресс корректный.

**Цель покрытия:** ~70% строк, 100% на `sender.js`.

## 13. Деплой

1. `git clone` на VPS, `npm ci --production`.
2. Скопировать `.env.example` → `.env`, заполнить: `APP_PASSWORD_HASH` (сгенерить через CLI-скрипт `node scripts/hash.js`), `SESSION_SECRET` (`openssl rand -hex 32`), `PORT=3000`, `COOKIE_DAYS=7`.
3. Скопировать `systemd/twitch-sender.service` в `/etc/systemd/system/`, поправить `WorkingDirectory` и `User`.
4. `systemctl daemon-reload && systemctl enable --now twitch-sender`.
5. Поставить Caddy, скопировать `Caddyfile.example`, поправить домен → перезапустить.
6. Открыть `https://your.domain/login`.

## 14. Вне scope (явно отказываемся)

- Авто-refresh OAuth-токенов.
- Авто-проверка живости прокси.
- Несколько одновременных job'ов.
- История прошлых рассылок / база логов.
- Авторизация на несколько пользователей.
- Discord/Telegram уведомления.
- Кастомные сообщения per-account (одно общее слово).
- Авто-замена IP при попадании прокси в бан-лист.
- UI/E2E-тесты.

## 15. Открытые вопросы

(Нет — все ключевые решения приняты в ходе брейншторма.)
