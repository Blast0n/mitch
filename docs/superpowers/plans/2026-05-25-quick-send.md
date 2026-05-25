# Quick Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Quick send" panel on the main page that lets the user pick one account from a searchable autocomplete and send an arbitrary message to the configured channel with a single Enter — bypassing the bulk-send orchestrator.

**Architecture:** New `POST /api/quick-send` endpoint that calls `twitch.sendOne` directly with proxy resolved via `sender.assignProxy(...)`. UI adds a small panel above the settings summary; client-side disables the panel while a bulk job is running.

**Tech Stack:** Existing — Express, `node:test`, `supertest`, vanilla HTML/JS. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-05-25-quick-send-design.md`](../specs/2026-05-25-quick-send-design.md)

---

## File Structure

```
routes/api.js                  # MODIFY — add POST /quick-send handler
test/api.test.js               # MODIFY — append 5 new tests
views/main.js                  # MODIFY — insert quicksend HTML at top
public/style.css               # MODIFY — append quicksend styles
public/app.js                  # MODIFY — add quicksend client logic + bulk-disable wiring
```

No new files. All changes are localised, none of the existing logic moves.

---

## Task 1: Backend — POST /api/quick-send

**Files:**
- Modify: `routes/api.js`
- Modify: `test/api.test.js`

- [ ] **Step 1: Add failing tests**

Append to `test/api.test.js` (after the existing tests, before any `describe`/EOF):

```js
// Helper to build a configured app with a real twitch.sendOne replacement
function buildAppWith(sendOneImpl) {
  const s = new Store(dir);
  const sender = createSender({ sendOne: sendOneImpl });
  const a = express();
  a.use(express.json());
  a.use('/api', apiRouter({ store: s, sender }));
  return { app: a, store: s, sender };
}

test('POST /api/quick-send happy path', async () => {
  const { app: a, store: s } = buildAppWith(async () => ({ ok: true, durationMs: 42 }));
  await s.write('accounts', [{ login: 'alice', oauthToken: 'oauth:' + 'a'.repeat(30) }]);
  await s.write('settings', { channel: 'somechan', word: 'unused', accountsPerProxy: 5, spreadSeconds: 0, concurrency: 1 });
  const r = await request(a).post('/api/quick-send').send({ login: 'alice', message: 'hello' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.durationMs, 42);
  assert.equal(r.body.proxy, 'direct');
});

test('POST /api/quick-send uses assignProxy for proxy selection', async () => {
  let receivedProxy = null;
  const { app: a, store: s } = buildAppWith(async (account, proxy) => { receivedProxy = proxy; return { ok: true, durationMs: 1 }; });
  await s.write('accounts', [
    { login: 'a0', oauthToken: 'oauth:' + 'x'.repeat(30) },
    { login: 'a1', oauthToken: 'oauth:' + 'y'.repeat(30) }
  ]);
  await s.write('proxies', [{ host: '1.2.3.4', port: 1080 }, { host: '5.6.7.8', port: 1080 }]);
  await s.write('settings', { channel: 'c', word: 'w', accountsPerProxy: 1, spreadSeconds: 0, concurrency: 1 });
  const r = await request(a).post('/api/quick-send').send({ login: 'a1', message: 'hi' });
  assert.equal(r.status, 200);
  assert.equal(receivedProxy?.host, '5.6.7.8');
  assert.equal(r.body.proxy, '5.6.7.8:1080');
});

test('POST /api/quick-send returns ok:false from sendOne result', async () => {
  const { app: a, store: s } = buildAppWith(async () => ({ ok: false, error: 'token_invalid', durationMs: 10 }));
  await s.write('accounts', [{ login: 'alice', oauthToken: 'oauth:' + 'a'.repeat(30) }]);
  await s.write('settings', { channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: 0, concurrency: 1 });
  const r = await request(a).post('/api/quick-send').send({ login: 'alice', message: 'hi' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, 'token_invalid');
});

test('POST /api/quick-send 409 when bulk job running', async () => {
  let release;
  const blocker = new Promise(r => { release = r; });
  const { app: a, store: s, sender } = buildAppWith(async () => { await blocker; return { ok: true, durationMs: 1 }; });
  await s.write('accounts', [{ login: 'alice', oauthToken: 'oauth:' + 'a'.repeat(30) }]);
  await s.write('settings', { channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: 0, concurrency: 1 });
  // start bulk
  await request(a).post('/api/send').send({}).expect(202);
  // quick-send while bulk running
  const r = await request(a).post('/api/quick-send').send({ login: 'alice', message: 'hi' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'bulk_running');
  release();
});

test('POST /api/quick-send 404 unknown login', async () => {
  const { app: a, store: s } = buildAppWith(async () => ({ ok: true, durationMs: 1 }));
  await s.write('accounts', [{ login: 'alice', oauthToken: 'oauth:' + 'a'.repeat(30) }]);
  await s.write('settings', { channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: 0, concurrency: 1 });
  const r = await request(a).post('/api/quick-send').send({ login: 'nobody', message: 'hi' });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'unknown_account');
});

test('POST /api/quick-send 400 on empty message', async () => {
  const { app: a, store: s } = buildAppWith(async () => ({ ok: true, durationMs: 1 }));
  await s.write('accounts', [{ login: 'alice', oauthToken: 'oauth:' + 'a'.repeat(30) }]);
  await s.write('settings', { channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: 0, concurrency: 1 });
  const r = await request(a).post('/api/quick-send').send({ login: 'alice', message: '   ' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'empty_message');
});

test('POST /api/quick-send 400 when channel not configured', async () => {
  const { app: a, store: s } = buildAppWith(async () => ({ ok: true, durationMs: 1 }));
  await s.write('accounts', [{ login: 'alice', oauthToken: 'oauth:' + 'a'.repeat(30) }]);
  await s.write('settings', { channel: '', word: 'w', accountsPerProxy: 5, spreadSeconds: 0, concurrency: 1 });
  const r = await request(a).post('/api/quick-send').send({ login: 'alice', message: 'hi' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'no_channel');
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npm test
```
Expected: 7 new tests fail (route does not exist).

- [ ] **Step 3: Implement handler in `routes/api.js`**

Two changes:

(a) Add import for `sendOne` and `assignProxy` at the top of `routes/api.js`:

```js
import { sendOne } from '../twitch.js';
import { assignProxy } from '../sender.js';
```

Replace the existing import line that says `import { validateAccounts, validateProxies, validateSettings } from '../store.js';` to keep both imports — final imports block should look like:

```js
import { Router } from 'express';
import { validateAccounts, validateProxies, validateSettings } from '../store.js';
import { sendOne } from '../twitch.js';
import { assignProxy } from '../sender.js';
```

(b) Add the `/quick-send` route inside the `apiRouter` function, after `crud('settings', validateSettings);` and before the other `r.post(...)` definitions:

```js
  r.post('/quick-send', async (req, res) => {
    if (sender.isRunning()) return res.status(409).json({ error: 'bulk_running' });
    const { login, message } = req.body || {};
    if (typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: 'empty_message' });
    }
    const [accounts, proxies, settings] = await Promise.all([
      store.read('accounts'), store.read('proxies'), store.read('settings')
    ]);
    if (!settings.channel) return res.status(400).json({ error: 'no_channel' });
    const idx = accounts.findIndex(a => a.login === login);
    if (idx < 0) return res.status(404).json({ error: 'unknown_account' });
    const proxy = assignProxy(idx, proxies, settings.accountsPerProxy);
    const proxyLabel = proxy ? `${proxy.host}:${proxy.port}` : 'direct';
    const result = await sendOne(accounts[idx], proxy, settings.channel, message);
    res.json({ ...result, proxy: proxyLabel });
  });
```

Note on test setup: the existing tests use `apiRouter({ store, sender })` where `sender` is built with a mock `sendOne`. The handler imports `sendOne` from `../twitch.js` directly, which would call real Twitch in tests. **To make tests work, the handler should use a `sendOne` injected via the router factory rather than the imported one.**

Revise the implementation:

```js
export function apiRouter({ store, sender, sendOne: sendOneImpl }) {
  const r = Router();
  const sendOneFn = sendOneImpl ?? sendOne;
  // ... existing crud block unchanged ...
  // Then in the quick-send handler, replace `sendOne(...)` with `sendOneFn(...)`
}
```

And the test helper `buildAppWith(sendOneImpl)` from Step 1 needs to pass `sendOne: sendOneImpl` to `apiRouter`. Update it now:

```js
function buildAppWith(sendOneImpl) {
  const s = new Store(dir);
  const sender = createSender({ sendOne: sendOneImpl });
  const a = express();
  a.use(express.json());
  a.use('/api', apiRouter({ store: s, sender, sendOne: sendOneImpl }));
  return { app: a, store: s, sender };
}
```

(This change to the test was already incorporated above — apply both edits.)

Also update `server.js` to keep current behaviour (it doesn't pass `sendOne` explicitly, so the default import is used). Open `server.js`, find the line `app.use('/api', requireAuth, csrf, apiRouter({ store, sender }));` — no change needed; `sendOne` will fall through to the imported default.

- [ ] **Step 4: Run, verify pass**

```bash
npm test
```
Expected: all 60 tests pass (53 existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add routes/api.js test/api.test.js
git commit -m "feat(api): POST /api/quick-send for single-account interactive send"
```

---

## Task 2: UI scaffolding — HTML + CSS

**Files:**
- Modify: `views/main.js`
- Modify: `public/style.css`

No automated tests for this task — manual smoke in Task 3.

- [ ] **Step 1: Update `views/main.js`**

Find the current `mainPage` function (after the `esc()` helper). The current body starts with `<h1>Send</h1>`. Insert the quicksend section between `<h1>Send</h1>` and the existing `<section class="summary">`:

```html
<h1>Send</h1>
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
<section class="summary">
  ...rest unchanged...
</section>
```

Make this edit by replacing the existing `<h1>Send</h1>\n<section class="summary">` opening with the version above. The rest of the function (settings summary, job-stats, log-details, table, summary `<p>`) stays exactly the same.

- [ ] **Step 2: Append CSS to `public/style.css`**

Append at the bottom of `public/style.css`:

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

- [ ] **Step 3: Smoke-verify**

```bash
npm test
```
Expected: 60 tests still pass (no regressions from this purely-visual change).

Quick visual check (optional, requires server running):
```bash
npm start
# open http://127.0.0.1:3000 in browser, log in
# you should see a "Quick send" panel above the settings summary
# the inputs and ▶ button are there but do nothing yet (JS in Task 3)
```

- [ ] **Step 4: Commit**

```bash
git add views/main.js public/style.css
git commit -m "ui(quicksend): add HTML scaffolding and styles for quick-send panel"
```

---

## Task 3: UI behaviour — client JS + bulk-job disable

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: Extend `ERROR_LABELS` in `public/app.js`**

Find the `ERROR_LABELS` object (inside the `if ($('#send-btn')) { ... }` block). Add 4 entries (preserve existing ones):

```js
  const ERROR_LABELS = {
    token_invalid: 'Токен невалиден или протух',
    proxy_unreachable: 'Прокси не отвечает',
    proxy_auth_failed: 'Прокси: неверный логин/пароль',
    twitch_unreachable: 'Twitch недоступен',
    chat_blocked: 'Аккаунт заблокирован в чате',
    join_failed: 'Не удалось войти в канал',
    timeout: 'Превышено время ожидания (15 сек)',
    unknown: 'Неизвестная ошибка',
    bulk_running: 'Идёт bulk-send, подожди завершения',
    unknown_account: 'Аккаунт не найден',
    empty_message: 'Введи сообщение',
    no_channel: 'В Settings не задан канал'
  };
```

- [ ] **Step 2: Add a `qsSetDisabled()` helper** inside the main-page block (the one starting `if ($('#send-btn')) {`)

Find a good spot — right after the `clearLog()` function definition. Add:

```js
  function qsSetDisabled(disabled) {
    const ids = ['qs-login', 'qs-message', 'qs-send'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.disabled = disabled;
    }
    const status = document.getElementById('qs-status');
    if (status && disabled) {
      status.className = '';
      status.textContent = 'Жди завершения bulk-send';
    } else if (status && status.textContent === 'Жди завершения bulk-send') {
      status.textContent = '';
    }
  }
```

- [ ] **Step 3: Wire `qsSetDisabled` into bulk lifecycle**

In the same main-page block, find the `startJob` function. Right after `stats.hidden = false;` (near the top), add:

```js
    qsSetDisabled(true);
```

So the start of `startJob` looks like:

```js
  async function startJob(endpoint) {
    btn.disabled = true;
    tbody.innerHTML = '';
    summaryEl.textContent = '';
    retry.hidden = true;
    clearLog();
    stats.hidden = false;
    qsSetDisabled(true);
    // ... rest unchanged
```

And in the `done` handler inside `attachSSE`, after `stopElapsed();`, add `qsSetDisabled(false);`:

```js
    es.addEventListener('done', (e) => {
      const { summary: s } = JSON.parse(e.data);
      summaryEl.textContent = `Готово: ${s.ok}/${s.total} ok, ${s.failed} failed`;
      btn.disabled = false;
      if (s.failed > 0) retry.hidden = false;
      stopElapsed();
      qsSetDisabled(false);
      logEvent({ text: `завершено: ${s.ok}/${s.total} успешно, ${s.failed} с ошибкой`, kind: s.failed === 0 ? 'ok' : 'err' });
      es.close();
    });
```

Also handle the 409 + fetch-failure paths in `startJob` (the `else if (r.status === 409)` and `else` branches). When the bulk doesn't actually start, we shouldn't leave quicksend disabled. Find both branches and add `qsSetDisabled(false);` next to the existing `stopElapsed();` call:

```js
    } else if (r.status === 409) {
      const body = await r.json();
      logEvent({ text: 'job уже идёт, подключаемся', kind: 'err' });
      if (body.jobId) attachSSE(body.jobId);
      else { summaryEl.textContent = 'A job is already running.'; btn.disabled = false; qsSetDisabled(false); stopElapsed(); }
    } else {
      const body = await r.json().catch(() => ({}));
      summaryEl.textContent = 'Error: ' + (body.error || r.status);
      logEvent({ text: 'не удалось запустить: ' + (body.error || r.status), kind: 'err' });
      btn.disabled = false;
      qsSetDisabled(false);
      stopElapsed();
    }
```

- [ ] **Step 4: Add the quicksend handler block**

At the end of `public/app.js` (after the closing `}` of the main-page `if`), append the new block:

```js
// ===== Quick send (lives on the main page, but in its own block to keep imports clean) =====
if ($('#qs-form')) {
  const form = $('#qs-form');
  const loginInp = $('#qs-login');
  const msgInp = $('#qs-message');
  const sendBtn = $('#qs-send');
  const statusEl = $('#qs-status');
  const datalist = $('#qs-accounts');
  const logEl = $('#event-log');

  const ERROR_LABELS = {
    token_invalid: 'Токен невалиден или протух',
    proxy_unreachable: 'Прокси не отвечает',
    proxy_auth_failed: 'Прокси: неверный логин/пароль',
    twitch_unreachable: 'Twitch недоступен',
    chat_blocked: 'Аккаунт заблокирован в чате',
    join_failed: 'Не удалось войти в канал',
    timeout: 'Превышено время ожидания (15 сек)',
    unknown: 'Неизвестная ошибка',
    bulk_running: 'Идёт bulk-send, подожди завершения',
    unknown_account: 'Аккаунт не найден',
    empty_message: 'Введи сообщение',
    no_channel: 'В Settings не задан канал'
  };
  const errLabel = (code) => code ? (ERROR_LABELS[code] || code) : '';

  function pad(n) { return String(n).padStart(2, '0'); }
  function nowStamp() {
    const d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function logEvent({ text, kind, login }) {
    if (!logEl) return;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = '[' + nowStamp() + '] ';
    const who = document.createElement('span');
    who.className = 'log-login';
    who.textContent = login ? login + ' → ' : '';
    const msg = document.createElement('span');
    if (kind === 'ok') msg.className = 'log-ok';
    else if (kind === 'err') msg.className = 'log-err';
    msg.textContent = text;
    const line = document.createElement('div');
    line.append(time, who, msg);
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.className = ok === true ? 'ok' : ok === false ? 'error' : '';
  }

  // Load login list into datalist on page load.
  fetch('/api/accounts', { credentials: 'same-origin' })
    .then(r => r.status === 401 ? (location.href = '/login', null) : r.json())
    .then(rows => {
      if (!rows) return;
      datalist.innerHTML = '';
      for (const a of rows) {
        const opt = document.createElement('option');
        opt.value = a.login;
        datalist.appendChild(opt);
      }
    })
    .catch(() => {});

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const login = loginInp.value.trim();
    const message = msgInp.value;
    if (!login || !message.trim()) {
      setStatus('Заполни оба поля', false);
      return;
    }
    sendBtn.disabled = true;
    setStatus('отправка…');
    const preview = message.length > 40 ? message.slice(0, 40) + '…' : message;
    logEvent({ login, text: `quick: "${preview}"` });
    try {
      const r = await fetch('/api/quick-send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ login, message })
      });
      if (r.status === 401) { location.href = '/login'; return; }
      const body = await r.json().catch(() => ({}));
      if (r.status === 200 && body.ok) {
        setStatus(`ok (${body.durationMs}ms) через ${body.proxy}`, true);
        logEvent({ login, text: `ok (${body.durationMs}ms через ${body.proxy})`, kind: 'ok' });
        msgInp.value = '';
        msgInp.focus();
      } else if (r.status === 200 && !body.ok) {
        const label = errLabel(body.error);
        setStatus(label, false);
        logEvent({ login, text: 'ошибка: ' + label, kind: 'err' });
      } else {
        const label = errLabel(body.error) || `HTTP ${r.status}`;
        setStatus(label, false);
        logEvent({ login, text: 'ошибка: ' + label, kind: 'err' });
      }
    } catch (err) {
      setStatus('Сеть: ' + err.message, false);
      logEvent({ login, text: 'сеть: ' + err.message, kind: 'err' });
    } finally {
      sendBtn.disabled = false;
    }
  });
}
```

Note: this block duplicates `ERROR_LABELS`, `nowStamp`, `pad`, and `logEvent`. That is intentional — the main-page and quicksend blocks are independent and may run on different pages in the future. DRY across `if` branches in this file is not worth the coupling. (The skill spec mentions YAGNI; we'll consolidate only when there's a third call site.)

- [ ] **Step 5: Verify no regressions**

```bash
npm test
```
Expected: 60 tests still pass.

- [ ] **Step 6: Manual smoke**

```bash
npm start
```

Open `http://127.0.0.1:3000`, log in.

Test cases:
1. **Datalist populated**: click the «Логин аккаунта» field — browser shows your account logins as suggestions.
2. **Successful send** (use a real working account + channel): type a logged-in login, then a message, press Enter. Status shows `ok (Nms) через ...`, message field clears, focus stays in message field. The chat shows the message.
3. **Unknown login**: type a non-existent login → Enter → red status `Аккаунт не найден`.
4. **Empty message**: clear message → Enter → red status `Заполни оба поля`.
5. **No channel** (clear `/settings` channel temporarily): Enter → red status `В Settings не задан канал`.
6. **During bulk send**: hit the main Send button, then immediately try quicksend → inputs and ▶ are `disabled`, status reads «Жди завершения bulk-send». When bulk finishes, quicksend reactivates.
7. **Event log**: every quicksend attempt appears in the event log panel above the table.

- [ ] **Step 7: Commit**

```bash
git add public/app.js
git commit -m "feat(quicksend): client logic, datalist, bulk-job disable wiring"
```

- [ ] **Step 8: Push**

```bash
git push origin main
```

---

## Self-Review Notes

**Spec coverage:**

| Spec requirement | Implementing task |
|---|---|
| §2.1 panel above settings | Task 2 |
| §2.2 login datalist autocomplete | Task 2 (HTML) + Task 3 (datalist fill) |
| §2.3 message input | Task 2 + Task 3 |
| §2.4 Enter submits | Task 3 (form submit) |
| §2.5 proxy via assignProxy + channel from settings | Task 1 (handler) |
| §2.6 message clears, login stays | Task 3 (msgInp.value = '', focus msg) |
| §2.7 inline error status | Task 3 (setStatus) |
| §2.8 event log integration | Task 3 (logEvent) |
| §2.9 disabled during bulk | Task 3 (qsSetDisabled + wiring) |
| §2.10 no confirmations | Task 3 (direct fetch on submit) |
| §5 API contract | Task 1 |
| §7 ERROR_LABELS extension | Task 3 (Step 1) |
| §8 tests | Task 1 (7 tests) |

**Known scope limitations carried from spec §10:** no history, no command-style PRIVMSG (`/me`), no hotkeys beyond Enter, no parallel quick-send.

**Total estimate:** 3 tasks × ~10 min = ~30 min for a competent dev.
