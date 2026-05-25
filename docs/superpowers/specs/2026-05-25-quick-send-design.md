# Quick Send — Design

**Дата:** 2026-05-25
**Статус:** Утверждено к реализации
**Связанные документы:** [`2026-05-24-twitch-multi-sender-design.md`](2026-05-24-twitch-multi-sender-design.md) (базовая система)

## 1. Цель

Добавить на главную страницу панель «Quick send»: поле поиска по никам аккаунтов с авто-подсказкой + поле сообщения + кнопка. После выбора аккаунта пользователь вводит произвольный текст и одной кнопкой/Enter отправляет его в канал из settings — без подтверждений. Использует те же прокси-правила и `twitch.sendOne`, что и bulk-send, но в обход оркестратора `sender`.

## 2. Функциональные требования

1. Панель quick-send отображается **над** settings-summary на главной (`/`).
2. Поле «логин» — `<input list="...">` + `<datalist>` со всеми логинами из `accounts.json`. Браузерная авто-подсказка.
3. Поле «сообщение» — обычный `<input>`. Произвольный текст пользователя.
4. Кнопка «▶» либо `Enter` в любом из полей → запуск отправки (только если оба заполнены).
5. Отправка использует:
   - Аккаунт по введённому логину (из `accounts.json`)
   - Канал из `settings.channel`
   - Прокси по правилу `assignProxy(accounts.indexOf(account), proxies, settings.accountsPerProxy)`
   - Сообщение — то, что ввёл пользователь
6. После успешной отправки: поле сообщения очищается, фокус возвращается в него, логин остаётся выбранным.
7. После неудачной отправки: оба поля остаются, показывается inline-статус с человеко-читаемым описанием ошибки.
8. Каждая попытка quick-send (успех или ошибка) добавляется в существующий event log:
   - `[HH:MM:SS] login → quick: "сообщение" (через host:port|direct)`
   - `[HH:MM:SS] login → ok (Nms)` или `[HH:MM:SS] login → ошибка: <text>`
9. Во время идущего bulk-send: оба поля + кнопка `disabled`, подсказка «Жди завершения bulk-send». После завершения — снова активны.
10. Без подтверждений, без модалок, без задержек.

## 3. Нефункциональные требования

- Не вводить новых runtime-зависимостей.
- Не ломать существующую single-job логику `sender` — quick-send идёт в обход.
- Сообщение не сохраняется в state: только в логе.
- Логин нечувствителен к регистру при поиске, но в API/IRC уходит как есть из `accounts.json`.

## 4. Архитектура

Без новых компонентов. Используется существующий стек:

```
[Browser quick-send UI] --POST /api/quick-send--> [Express] --> [twitch.sendOne] --WSS via SOCKS5--> [Twitch IRC]
                                                       |
                                                       +-- store.read('accounts'|'proxies'|'settings')
                                                       +-- sender.assignProxy() (pure fn)
                                                       +-- sender.isRunning() (для 409)
```

`sender` НЕ запускается — это конкурентный канал для разовой отправки.

## 5. API

### `POST /api/quick-send`

**Auth:** да (требует cookie, как все `/api/*`).
**Body:**
```json
{ "login": "user1", "message": "привет всем" }
```

**Алгоритм:**
1. Если `sender.isRunning()` → `409 {"error":"bulk_running"}`.
2. Прочитать `accounts`, `proxies`, `settings`.
3. Если `typeof message !== 'string'` или `message.trim() === ''` → `400 {"error":"empty_message"}`.
4. Если `!settings.channel` → `400 {"error":"no_channel"}`.
5. Найти `accounts.findIndex(a => a.login === login)`. Если `< 0` → `404 {"error":"unknown_account"}`.
6. `proxy = assignProxy(idx, proxies, settings.accountsPerProxy)`.
7. `result = await twitch.sendOne(account, proxy, settings.channel, message)`.
8. Вернуть `200 {ok, error?, durationMs, proxy: 'host:port'|'direct'}`.

**Замечание:** даже при `result.ok === false` HTTP-код 200 (не 502) — фронту проще, ошибка передаётся в поле `error`. Это согласуется с тем, как bulk-send уже возвращает результаты в SSE.

## 6. UI

### HTML (вставка в `views/main.js` сразу после `<h1>Send</h1>`)

```html
<section class="quicksend">
  <h2>Quick send</h2>
  <form id="qs-form" autocomplete="off">
    <input id="qs-login" list="qs-accounts" placeholder="Логин аккаунта" required>
    <datalist id="qs-accounts"></datalist>
    <input id="qs-message" placeholder="Сообщение" required>
    <button id="qs-send" type="submit">▶</button>
  </form>
  <div id="qs-status"></div>
</section>
```

### JS (новая секция в `public/app.js`, активируется при наличии `#qs-form`)

- На load: `fetch('/api/accounts')` → заполнить `<datalist>` опциями `<option value="login">`.
- На submit формы:
  - `preventDefault()`
  - валидация (оба поля непустые)
  - disable кнопки на время отправки, показать «отправка…»
  - `POST /api/quick-send` с `{login, message}`
  - на ok=true: очистить `#qs-message`, фокус туда же, `qs-status` зелёным «ok (Nms)»; добавить 2 строки в event log
  - на ok=false: `qs-status` красным с текстом ошибки; в event log тоже
  - на 4xx/5xx: показать соответствующее сообщение
- Отслеживать состояние bulk job через тот же SSE-канал: на `sending`/`progress`/`done` events обновлять `disabled` инпутов quick-send.
  - Простейший способ: при старте bulk-job в `startJob()` устанавливаем `qsDisable(true)`, при `done` → `qsDisable(false)`.

### CSS (добавить в `public/style.css`)

```css
.quicksend { margin-bottom:1rem; padding:.75rem 1rem; background:#1a1d24; border-radius:6px; }
.quicksend h2 { font-size:1rem; margin:0 0 .5rem; color:var(--muted); }
.quicksend form { display:flex; gap:.5rem; align-items:center; max-width:none; }
.quicksend input { flex:1; }
.quicksend #qs-login { flex:0 0 200px; }
.quicksend button { flex:0 0 3rem; }
#qs-status { margin-top:.4rem; min-height:1.2rem; font-size:.9rem; }
#qs-status.ok { color:var(--ok); }
#qs-status.error { color:var(--danger); }
```

## 7. Обработка ошибок

Используем существующие коды и `ERROR_LABELS` из `public/app.js`:

| Код | Описание (русский) |
|---|---|
| `bulk_running` | Идёт bulk-send, подожди завершения |
| `unknown_account` | Аккаунт «X» не найден в списке |
| `empty_message` | Введи сообщение |
| `no_channel` | В Settings не задан канал |
| `token_invalid` | Токен невалиден или протух |
| `proxy_unreachable` | Прокси не отвечает |
| `twitch_unreachable` | Twitch недоступен |
| `chat_blocked` | Аккаунт заблокирован в чате |
| `timeout` | Превышено время ожидания (15 сек) |
| `unknown` | Неизвестная ошибка |

Маппинг расширяется в `ERROR_LABELS` четырьмя новыми кодами: `bulk_running`, `unknown_account`, `empty_message`, `no_channel`.

## 8. Тестирование

### Unit-тесты в `test/api.test.js`

Добавить блок:

1. `POST /api/quick-send happy path`:
   - setup: 1 аккаунт + settings с каналом
   - mock sender (sendOne возвращает ok)
   - ожидаем 200, `body.ok === true`
2. `POST /api/quick-send 409 when bulk running`:
   - Запустить bulk-send (медленный sendOne)
   - quick-send → 409
3. `POST /api/quick-send 404 on unknown login`:
   - setup без аккаунтов
   - quick-send с любым login → 404
4. `POST /api/quick-send 400 on empty message`:
   - валидный аккаунт, message=''
5. `POST /api/quick-send 400 on no channel`:
   - settings.channel пустой

### Manual smoke

1. Открыть `/`, ввести логин из datalist → авто-подсказка работает.
2. Ввести сообщение, нажать Enter → сообщение приходит в чат.
3. Подряд несколько Enter с разными текстами → каждый раз новый message в чате, account-поле не меняется.
4. Запустить bulk-send → quick-send disabled.
5. По завершении bulk → quick-send снова активен.

## 9. Безопасность

- Auth обязателен (тот же `requireAuth` для `/api/*`).
- CSRF: уже покрыто существующим middleware (`csrf.js`).
- Message не сохраняется в JSON-store — только в RAM event log.
- Логирование: не пишем токены, только login + первые ~40 символов message (для отладки на VPS).

## 10. Вне scope

- История quick-send отправок (нет persistent log).
- Поддержка emote-кодов / форматирования.
- Команды Twitch (`/me`, `/timeout` и т.п.) — допускается, но не специально поддерживается (просто шлём как обычный PRIVMSG-text).
- Авто-фокус из URL-параметра (`/?qs=user1`).
- Drag-n-drop, hotkeys кроме Enter.
- Множественные quick-send параллельно (одна отправка за раз — кнопка disabled на время запроса).
