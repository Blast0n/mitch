# Twitch Multi-Sender Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-password web app that sends one message from N Twitch accounts into a target channel through SOCKS5 proxies, with N-accounts-per-proxy grouping, spread-over-time scheduling, and live SSE progress.

**Architecture:** Node.js monolith — Express HTTP, vanilla HTML/JS frontend, JSON-file storage. Custom thin Twitch IRC layer over `ws` + `socks-proxy-agent` (tmi.js intentionally avoided due to poor proxy support). One in-memory job at a time, SSE for progress.

**Tech Stack:** Node 20 LTS, `express`, `ws`, `socks-proxy-agent`, `bcrypt`, `cookie-signature`, `express-rate-limit`, `p-limit`, `dotenv`. Tests: `node:test` + `supertest`.

**Spec:** [`docs/superpowers/specs/2026-05-24-twitch-multi-sender-design.md`](../specs/2026-05-24-twitch-multi-sender-design.md)

---

## File Structure

```
.
├── server.js                  # Express bootstrap, route mounting
├── auth.js                    # HMAC cookie sign/verify, bcrypt, middleware
├── store.js                   # Read/write data/*.json atomically + validation
├── twitch.js                  # IRC framing (pure) + sendOne (network)
├── sender.js                  # Job orchestrator: scheduling, proxy assignment, concurrency, events
├── csrf.js                    # Origin/Referer check middleware
├── routes/
│   ├── pages.js               # HTML pages (server-rendered)
│   └── api.js                 # JSON API + SSE
├── views/
│   ├── layout.js              # base HTML wrapper
│   ├── login.js
│   ├── main.js
│   ├── accounts.js
│   ├── proxies.js
│   └── settings.js
├── public/
│   ├── app.js                 # client-side: fetch, SSE, table editors
│   └── style.css
├── scripts/
│   └── hash.js                # CLI: generate bcrypt hash for APP_PASSWORD_HASH
├── data/                      # gitignored, auto-created on first start
├── test/
│   ├── store.test.js
│   ├── auth.test.js
│   ├── twitch.test.js
│   ├── sender.test.js
│   └── api.test.js
├── .env.example
├── .gitignore                 # data/, .env, node_modules/
├── Caddyfile.example
├── systemd/
│   └── twitch-sender.service
├── package.json
└── README.md
```

---

## Task 1: Project Bootstrap

**Files:**
- Create: `package.json`, `.env.example`, `.gitignore` (update existing), `.nvmrc`

- [ ] **Step 1: Update `.gitignore`**

Append to existing `.gitignore` (already contains `data/`, `.env`, `node_modules/`):

```
# OS / editors
*.log
.idea/
.vscode/
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "twitch-multi-sender",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/",
    "test:watch": "node --test --watch test/",
    "hash": "node scripts/hash.js"
  },
  "dependencies": {
    "bcrypt": "^5.1.1",
    "cookie-signature": "^1.2.2",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.4.0",
    "p-limit": "^5.0.0",
    "socks-proxy-agent": "^8.0.4",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 3: Create `.env.example`**

```
# Required
APP_PASSWORD_HASH=     # bcrypt hash; generate via `npm run hash -- 'your-password'`
SESSION_SECRET=        # 32 random bytes hex; generate via `openssl rand -hex 32`

# Optional (defaults shown)
PORT=3000
COOKIE_DAYS=7
```

- [ ] **Step 4: Create `.nvmrc`**

```
20
```

- [ ] **Step 5: Install and commit**

```bash
npm install
git add package.json package-lock.json .env.example .gitignore .nvmrc
git commit -m "chore: project bootstrap"
```

Expected: `node_modules/` populated, ~7 direct deps + transitive.

---

## Task 2: store.js — Read/Write with Atomic Rename

**Files:**
- Create: `store.js`, `test/store.test.js`

- [ ] **Step 1: Write failing test for `read` defaults**

Create `test/store.test.js`:

```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { Store } from '../store.js';

let dir;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'store-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test('read returns default when file missing', async () => {
  const store = new Store(dir);
  assert.deepEqual(await store.read('accounts'), []);
  assert.deepEqual(await store.read('proxies'), []);
  const s = await store.read('settings');
  assert.equal(s.channel, '');
  assert.equal(s.accountsPerProxy, 5);
  assert.equal(s.concurrency, 5);
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npm test -- --test-name-pattern="read returns default"
```
Expected: FAIL — `store.js` not found.

- [ ] **Step 3: Implement minimal `store.js`**

```js
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = {
  accounts: [],
  proxies: [],
  settings: {
    channel: '',
    word: '',
    accountsPerProxy: 5,
    spreadSeconds: 0,
    concurrency: 5
  }
};

export class Store {
  constructor(dir) { this.dir = dir; }

  async read(name) {
    const file = path.join(this.dir, `${name}.json`);
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return structuredClone(DEFAULTS[name]);
      if (err instanceof SyntaxError) {
        const e = new Error(`Corrupt JSON in ${name}.json: ${err.message}`);
        e.code = 'STORE_CORRUPT';
        throw e;
      }
      throw err;
    }
  }

  async write(name, data) {
    const file = path.join(this.dir, `${name}.json`);
    const tmp = file + '.tmp';
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npm test
```
Expected: 1 passing.

- [ ] **Step 5: Add write + roundtrip test**

Append to `test/store.test.js`:

```js
test('write then read roundtrip', async () => {
  const store = new Store(dir);
  await store.write('accounts', [{ login: 'a', oauthToken: 'oauth:xxx' }]);
  assert.deepEqual(await store.read('accounts'), [{ login: 'a', oauthToken: 'oauth:xxx' }]);
});

test('atomic write: tmp file removed after success', async () => {
  const store = new Store(dir);
  await store.write('proxies', [{ host: 'a', port: 1 }]);
  const files = await fs.readdir(dir);
  assert.ok(!files.some(f => f.endsWith('.tmp')));
});

test('corrupt JSON throws STORE_CORRUPT', async () => {
  await fs.writeFile(path.join(dir, 'accounts.json'), 'not json');
  const store = new Store(dir);
  await assert.rejects(() => store.read('accounts'), { code: 'STORE_CORRUPT' });
});
```

- [ ] **Step 6: Run tests, verify all pass**

```bash
npm test
```
Expected: 4 passing.

- [ ] **Step 7: Commit**

```bash
git add store.js test/store.test.js
git commit -m "feat(store): JSON read/write with atomic rename and defaults"
```

---

## Task 3: store.js — Validation Functions

**Files:**
- Modify: `store.js` (add exports)
- Modify: `test/store.test.js` (add tests)

- [ ] **Step 1: Write failing tests for validators**

Append to `test/store.test.js`:

```js
import { validateAccounts, validateProxies, validateSettings } from '../store.js';

test('validateAccounts: empty array is valid', () => {
  assert.deepEqual(validateAccounts([]), []);
});

test('validateAccounts: rejects missing login', () => {
  const errors = validateAccounts([{ oauthToken: 'oauth:abcdefghijklmnopqrstuvwxyz1234' }]);
  assert.ok(errors[0].includes('login'));
});

test('validateAccounts: rejects bad token prefix', () => {
  const errors = validateAccounts([{ login: 'a', oauthToken: 'wrong' }]);
  assert.ok(errors[0].includes('oauth:'));
});

test('validateAccounts: accepts valid entry', () => {
  assert.deepEqual(validateAccounts([{ login: 'a_b1', oauthToken: 'oauth:' + 'x'.repeat(30) }]), []);
});

test('validateProxies: rejects invalid port', () => {
  const errors = validateProxies([{ host: 'h', port: 99999 }]);
  assert.ok(errors[0].includes('port'));
});

test('validateProxies: accepts host:port only', () => {
  assert.deepEqual(validateProxies([{ host: '1.2.3.4', port: 1080 }]), []);
});

test('validateSettings: rejects negative spread', () => {
  const errors = validateSettings({ channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: -1, concurrency: 5 });
  assert.ok(errors.some(e => e.includes('spreadSeconds')));
});

test('validateSettings: rejects concurrency 0', () => {
  const errors = validateSettings({ channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: 0, concurrency: 0 });
  assert.ok(errors.some(e => e.includes('concurrency')));
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npm test
```
Expected: 4 new tests fail (import not found).

- [ ] **Step 3: Add validators to `store.js`**

Append to `store.js`:

```js
const LOGIN_RE = /^[a-zA-Z0-9_]+$/;

export function validateAccounts(arr) {
  const errors = [];
  if (!Array.isArray(arr)) return ['accounts: must be array'];
  arr.forEach((a, i) => {
    if (!a || typeof a !== 'object') errors.push(`row ${i + 1}: not an object`);
    else {
      if (typeof a.login !== 'string' || !LOGIN_RE.test(a.login)) errors.push(`row ${i + 1}: invalid login`);
      if (typeof a.oauthToken !== 'string' || !a.oauthToken.startsWith('oauth:') || a.oauthToken.length < 30) {
        errors.push(`row ${i + 1}: oauthToken must start with 'oauth:' and be ≥30 chars`);
      }
    }
  });
  return errors;
}

export function validateProxies(arr) {
  const errors = [];
  if (!Array.isArray(arr)) return ['proxies: must be array'];
  arr.forEach((p, i) => {
    if (!p || typeof p !== 'object') errors.push(`row ${i + 1}: not an object`);
    else {
      if (typeof p.host !== 'string' || !p.host) errors.push(`row ${i + 1}: empty host`);
      if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) errors.push(`row ${i + 1}: invalid port`);
      if (p.username != null && typeof p.username !== 'string') errors.push(`row ${i + 1}: username must be string`);
      if (p.password != null && typeof p.password !== 'string') errors.push(`row ${i + 1}: password must be string`);
    }
  });
  return errors;
}

export function validateSettings(s) {
  const errors = [];
  if (!s || typeof s !== 'object') return ['settings: must be object'];
  if (typeof s.channel !== 'string') errors.push('channel: must be string');
  if (typeof s.word !== 'string') errors.push('word: must be string');
  if (!Number.isInteger(s.accountsPerProxy) || s.accountsPerProxy < 1) errors.push('accountsPerProxy: must be positive int');
  if (!Number.isFinite(s.spreadSeconds) || s.spreadSeconds < 0) errors.push('spreadSeconds: must be ≥0');
  if (!Number.isInteger(s.concurrency) || s.concurrency < 1) errors.push('concurrency: must be positive int');
  return errors;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npm test
```
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add store.js test/store.test.js
git commit -m "feat(store): add validators for accounts, proxies, settings"
```

---

## Task 4: auth.js — HMAC Cookie Sign/Verify

**Files:**
- Create: `auth.js`, `test/auth.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/auth.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signCookie, verifyCookie } from '../auth.js';

const SECRET = 'a'.repeat(64);

test('signCookie produces verifiable token', () => {
  const token = signCookie({ ts: 1000 }, SECRET);
  const result = verifyCookie(token, SECRET);
  assert.equal(result.ts, 1000);
});

test('verifyCookie returns null on tampered payload', () => {
  const token = signCookie({ ts: 1000 }, SECRET);
  const tampered = token.replace('1000', '9999');
  assert.equal(verifyCookie(tampered, SECRET), null);
});

test('verifyCookie returns null on wrong secret', () => {
  const token = signCookie({ ts: 1000 }, SECRET);
  assert.equal(verifyCookie(token, 'b'.repeat(64)), null);
});

test('verifyCookie returns null on malformed input', () => {
  assert.equal(verifyCookie('garbage', SECRET), null);
  assert.equal(verifyCookie('', SECRET), null);
  assert.equal(verifyCookie(null, SECRET), null);
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npm test
```
Expected: 4 new fails.

- [ ] **Step 3: Implement in `auth.js`**

```js
import crypto from 'node:crypto';

export function signCookie(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyCookie(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add auth.js test/auth.test.js
git commit -m "feat(auth): HMAC cookie sign/verify"
```

---

## Task 5: auth.js — Middleware + Bcrypt

**Files:**
- Modify: `auth.js`, `test/auth.test.js`

- [ ] **Step 1: Write failing tests for middleware**

Append to `test/auth.test.js`:

```js
import { makeMiddleware, COOKIE_NAME } from '../auth.js';

function mockReq(cookieValue) {
  return { cookies: cookieValue ? { [COOKIE_NAME]: cookieValue } : {}, headers: {} };
}
function mockRes() {
  let status, redirectTo, body;
  return {
    redirect: (u) => { redirectTo = u; },
    status: (s) => ({ json: (b) => { status = s; body = b; } }),
    _get: () => ({ status, redirectTo, body })
  };
}

test('middleware: redirects html request without cookie', () => {
  const mw = makeMiddleware({ secret: SECRET, cookieMaxAgeMs: 1000 });
  const req = mockReq();
  req.headers.accept = 'text/html';
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._get().redirectTo, '/login');
});

test('middleware: 401 JSON for api request without cookie', () => {
  const mw = makeMiddleware({ secret: SECRET, cookieMaxAgeMs: 1000 });
  const req = { cookies: {}, headers: { accept: 'application/json' }, path: '/api/x' };
  const res = mockRes();
  mw(req, res, () => {});
  assert.equal(res._get().status, 401);
});

test('middleware: passes with valid fresh cookie', () => {
  const mw = makeMiddleware({ secret: SECRET, cookieMaxAgeMs: 60_000 });
  const cookie = signCookie({ ts: Date.now() }, SECRET);
  const req = mockReq(cookie);
  req.headers.accept = 'text/html';
  let nextCalled = false;
  mw(req, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('middleware: rejects expired cookie', () => {
  const mw = makeMiddleware({ secret: SECRET, cookieMaxAgeMs: 1000 });
  const cookie = signCookie({ ts: Date.now() - 10_000 }, SECRET);
  const req = mockReq(cookie);
  req.headers.accept = 'text/html';
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._get().redirectTo, '/login');
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement middleware in `auth.js`**

Append to `auth.js`:

```js
export const COOKIE_NAME = 'tms_sid';

export function makeMiddleware({ secret, cookieMaxAgeMs }) {
  return function authMw(req, res, next) {
    const raw = req.cookies?.[COOKIE_NAME];
    const payload = raw ? verifyCookie(raw, secret) : null;
    const fresh = payload && (Date.now() - payload.ts) < cookieMaxAgeMs;
    if (fresh) return next();
    const wantsJson = (req.path || '').startsWith('/api/') ||
                       (req.headers?.accept || '').includes('application/json');
    if (wantsJson) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect('/login');
  };
}

export function buildCookie(secret) {
  return signCookie({ ts: Date.now() }, secret);
}
```

Add bcrypt import and `verifyPassword` at the top of `auth.js`:

```js
import bcrypt from 'bcrypt';

export async function verifyPassword(plain, hash) {
  if (!hash || typeof hash !== 'string') return false;
  try { return await bcrypt.compare(plain, hash); }
  catch { return false; }
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add auth.js test/auth.test.js
git commit -m "feat(auth): middleware, bcrypt password verify"
```

---

## Task 6: scripts/hash.js — CLI Password Hasher

**Files:**
- Create: `scripts/hash.js`

- [ ] **Step 1: Implement**

```js
#!/usr/bin/env node
import bcrypt from 'bcrypt';

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash -- <password>');
  process.exit(1);
}
const hash = await bcrypt.hash(password, 12);
console.log(hash);
```

- [ ] **Step 2: Verify manually**

```bash
npm run hash -- testpass
```
Expected: prints a `$2b$12$...` hash.

- [ ] **Step 3: Commit**

```bash
git add scripts/hash.js
git commit -m "feat: CLI script to generate bcrypt hash"
```

---

## Task 7: twitch.js — IRC Framing (Pure)

**Files:**
- Create: `twitch.js`, `test/twitch.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/twitch.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPass, buildNick, buildJoin, buildPrivmsg, parseLine, isPing, isAuthFailNotice, isPostJoinErrorNotice } from '../twitch.js';

test('build commands', () => {
  assert.equal(buildPass('oauth:abc'), 'PASS oauth:abc');
  assert.equal(buildNick('USER'), 'NICK user');
  assert.equal(buildJoin('Chan'), 'JOIN #chan');
  assert.equal(buildPrivmsg('Chan', 'hi'), 'PRIVMSG #chan :hi');
});

test('parseLine: simple PING', () => {
  const p = parseLine('PING :tmi.twitch.tv');
  assert.equal(p.command, 'PING');
  assert.deepEqual(p.params, ['tmi.twitch.tv']);
});

test('parseLine: with prefix and trailing', () => {
  const p = parseLine(':tmi.twitch.tv NOTICE * :Login authentication failed');
  assert.equal(p.prefix, 'tmi.twitch.tv');
  assert.equal(p.command, 'NOTICE');
  assert.deepEqual(p.params, ['*', 'Login authentication failed']);
});

test('isPing', () => {
  assert.equal(isPing(parseLine('PING :tmi.twitch.tv')), true);
  assert.equal(isPing(parseLine('PRIVMSG #x :hi')), false);
});

test('isAuthFailNotice', () => {
  const ok = parseLine(':tmi.twitch.tv NOTICE * :Login authentication failed');
  const other = parseLine(':tmi.twitch.tv NOTICE #x :something else');
  assert.equal(isAuthFailNotice(ok), true);
  assert.equal(isAuthFailNotice(other), false);
});

test('isPostJoinErrorNotice', () => {
  const banned = parseLine(':tmi.twitch.tv NOTICE #x :You are permanently banned from talking in x.');
  const ok = parseLine(':tmi.twitch.tv NOTICE #x :This room is in r9k mode.');
  assert.equal(isPostJoinErrorNotice(banned), true);
  assert.equal(isPostJoinErrorNotice(ok), false);
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement framing in `twitch.js`**

```js
export const buildPass = (token) => `PASS ${token}`;
export const buildNick = (login) => `NICK ${login.toLowerCase()}`;
export const buildJoin = (channel) => `JOIN #${channel.toLowerCase()}`;
export const buildPrivmsg = (channel, msg) => `PRIVMSG #${channel.toLowerCase()} :${msg}`;

export function parseLine(line) {
  let i = 0, prefix = null;
  if (line[0] === ':') {
    const space = line.indexOf(' ');
    prefix = line.slice(1, space);
    i = space + 1;
  }
  const parts = [];
  while (i < line.length) {
    if (line[i] === ':') { parts.push(line.slice(i + 1)); break; }
    const next = line.indexOf(' ', i);
    if (next === -1) { parts.push(line.slice(i)); break; }
    parts.push(line.slice(i, next));
    i = next + 1;
  }
  return { prefix, command: parts[0], params: parts.slice(1) };
}

export const isPing = (msg) => msg.command === 'PING';

const NEGATIVE_NOTICE_MARKERS = [
  'login authentication failed',
  'invalid nick',
  'improperly formatted auth'
];

export function isAuthFailNotice(msg) {
  if (msg.command !== 'NOTICE') return false;
  const text = (msg.params[msg.params.length - 1] || '').toLowerCase();
  return NEGATIVE_NOTICE_MARKERS.some(m => text.includes(m));
}

const POST_JOIN_ERROR_MARKERS = [
  'banned from talking',
  'you don\'t have permission',
  'msg_banned',
  'msg_timedout',
  'you are sending messages too quickly',
  'this channel has been suspended',
  'no chatting in this channel'
];

export function isPostJoinErrorNotice(msg) {
  if (msg.command !== 'NOTICE') return false;
  const text = (msg.params[msg.params.length - 1] || '').toLowerCase();
  return POST_JOIN_ERROR_MARKERS.some(m => text.includes(m));
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add twitch.js test/twitch.test.js
git commit -m "feat(twitch): IRC framing builders and parsers"
```

---

## Task 8: twitch.js — sendOne with Injectable Transport

**Files:**
- Modify: `twitch.js`, `test/twitch.test.js`

- [ ] **Step 1: Write failing test using a fake transport**

Append to `test/twitch.test.js`:

```js
import { sendOne } from '../twitch.js';

// fakeTransport: array of script entries [{type:'expect', re:RegExp}|{type:'send', line:string}]
// drives a fake WebSocket-like object.
function fakeTransport(script) {
  let i = 0;
  const handlers = { message: [], open: [], close: [], error: [] };
  const sent = [];
  function step() {
    while (i < script.length && script[i].type === 'send') {
      const line = script[i++].line;
      queueMicrotask(() => handlers.message.forEach(h => h({ data: line + '\r\n' })));
    }
  }
  return {
    connect: () => {
      queueMicrotask(() => handlers.open.forEach(h => h()));
      step();
      return {
        on: (ev, fn) => { handlers[ev].push(fn); if (ev === 'open') step(); },
        send: (data) => {
          const trimmed = String(data).trim();
          sent.push(trimmed);
          if (i < script.length && script[i].type === 'expect') {
            if (!script[i].re.test(trimmed)) throw new Error(`unexpected: ${trimmed}`);
            i++;
            step();
          }
        },
        close: () => queueMicrotask(() => handlers.close.forEach(h => h()))
      };
    },
    sent
  };
}

test('sendOne: happy path', async () => {
  const t = fakeTransport([
    { type: 'expect', re: /^PASS / },
    { type: 'expect', re: /^NICK / },
    { type: 'expect', re: /^JOIN / },
    { type: 'expect', re: /^PRIVMSG / }
  ]);
  const result = await sendOne(
    { login: 'u', oauthToken: 'oauth:xxx' },
    null, 'chan', 'hello',
    { transport: t, postSendWaitMs: 50, overallTimeoutMs: 5000 }
  );
  assert.equal(result.ok, true);
  assert.ok(result.durationMs >= 0);
});

test('sendOne: token_invalid on auth fail NOTICE', async () => {
  const t = fakeTransport([
    { type: 'expect', re: /^PASS / },
    { type: 'expect', re: /^NICK / },
    { type: 'send', line: ':tmi.twitch.tv NOTICE * :Login authentication failed' }
  ]);
  const r = await sendOne(
    { login: 'u', oauthToken: 'oauth:bad' },
    null, 'chan', 'hi',
    { transport: t, postSendWaitMs: 50, overallTimeoutMs: 5000 }
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, 'token_invalid');
});

test('sendOne: chat_blocked on post-PRIVMSG NOTICE', async () => {
  const t = fakeTransport([
    { type: 'expect', re: /^PASS / },
    { type: 'expect', re: /^NICK / },
    { type: 'expect', re: /^JOIN / },
    { type: 'expect', re: /^PRIVMSG / },
    { type: 'send', line: ':tmi.twitch.tv NOTICE #chan :You are permanently banned from talking in chan.' }
  ]);
  const r = await sendOne(
    { login: 'u', oauthToken: 'oauth:xxx' },
    null, 'chan', 'hi',
    { transport: t, postSendWaitMs: 200, overallTimeoutMs: 5000 }
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, 'chat_blocked');
});

test('sendOne: PING/PONG handled during post-send wait', async () => {
  // Real Twitch sends PING any time. Our impl sends PASS/NICK/JOIN/PRIVMSG
  // back-to-back in `open`, then waits postSendWaitMs. PING arriving during
  // that wait must be answered with PONG.
  const t = fakeTransport([
    { type: 'expect', re: /^PASS / },
    { type: 'expect', re: /^NICK / },
    { type: 'expect', re: /^JOIN / },
    { type: 'expect', re: /^PRIVMSG / },
    { type: 'send', line: 'PING :tmi.twitch.tv' },
    { type: 'expect', re: /^PONG / }
  ]);
  const r = await sendOne(
    { login: 'u', oauthToken: 'oauth:xxx' },
    null, 'chan', 'hi',
    { transport: t, postSendWaitMs: 80, overallTimeoutMs: 5000 }
  );
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement `sendOne` with injectable transport**

Append to `twitch.js`:

```js
import WebSocket from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';

const TWITCH_WSS = 'wss://irc-ws.chat.twitch.tv:443';

// Default production transport. Opens a real WebSocket.
const defaultTransport = {
  connect(proxy) {
    const opts = {};
    if (proxy) {
      const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@` : '';
      opts.agent = new SocksProxyAgent(`socks5://${auth}${proxy.host}:${proxy.port}`);
    }
    const ws = new WebSocket(TWITCH_WSS, opts);
    return {
      on(ev, fn) {
        if (ev === 'open') ws.on('open', fn);
        else if (ev === 'message') ws.on('message', (data) => fn({ data: data.toString() }));
        else if (ev === 'close') ws.on('close', fn);
        else if (ev === 'error') ws.on('error', fn);
      },
      send: (line) => ws.send(line + '\r\n'),
      close: () => { try { ws.terminate(); } catch {} }
    };
  }
};

export async function sendOne(account, proxy, channel, word, opts = {}) {
  const transport = opts.transport ?? defaultTransport;
  const postSendWaitMs = opts.postSendWaitMs ?? 3000;
  const overallTimeoutMs = opts.overallTimeoutMs ?? 15000;
  const start = Date.now();
  let conn;
  let settled = false;
  let result;

  return new Promise((resolve) => {
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { conn?.close(); } catch {}
      clearTimeout(overall);
      clearTimeout(postSendTimer);
      resolve({ ...r, durationMs: Date.now() - start });
    };

    const overall = setTimeout(() => finish({ ok: false, error: 'timeout' }), overallTimeoutMs);
    let postSendTimer = null;
    let privmsgSent = false;

    try {
      conn = transport.connect(proxy);
    } catch (err) {
      return finish({ ok: false, error: 'proxy_unreachable', details: err.message });
    }

    conn.on('open', () => {
      try {
        conn.send(buildPass(account.oauthToken));
        conn.send(buildNick(account.login));
        conn.send(buildJoin(channel));
        conn.send(buildPrivmsg(channel, word));
        privmsgSent = true;
        postSendTimer = setTimeout(() => finish({ ok: true }), postSendWaitMs);
      } catch (err) {
        finish({ ok: false, error: 'unknown', details: err.message });
      }
    });

    conn.on('message', (ev) => {
      const lines = String(ev.data).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const msg = parseLine(line);
        if (isPing(msg)) {
          conn.send('PONG :' + (msg.params[0] || 'tmi.twitch.tv'));
          continue;
        }
        if (isAuthFailNotice(msg)) {
          return finish({ ok: false, error: 'token_invalid' });
        }
        if (privmsgSent && isPostJoinErrorNotice(msg)) {
          return finish({ ok: false, error: 'chat_blocked', details: msg.params[msg.params.length - 1] });
        }
      }
    });

    conn.on('error', (err) => finish({ ok: false, error: 'twitch_unreachable', details: err?.message }));
    conn.on('close', () => {
      if (!privmsgSent) finish({ ok: false, error: 'twitch_unreachable' });
    });
  });
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add twitch.js test/twitch.test.js
git commit -m "feat(twitch): sendOne with injectable transport and error classification"
```

---

## Task 9: sender.js — Proxy Assignment Helper

**Files:**
- Create: `sender.js`, `test/sender.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/sender.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignProxy } from '../sender.js';

test('assignProxy: no proxies returns null', () => {
  assert.equal(assignProxy(0, [], 5), null);
  assert.equal(assignProxy(99, [], 5), null);
});

test('assignProxy: groups of N', () => {
  const proxies = [{ host: 'a' }, { host: 'b' }, { host: 'c' }];
  assert.equal(assignProxy(0, proxies, 5).host, 'a');
  assert.equal(assignProxy(4, proxies, 5).host, 'a');
  assert.equal(assignProxy(5, proxies, 5).host, 'b');
  assert.equal(assignProxy(9, proxies, 5).host, 'b');
  assert.equal(assignProxy(10, proxies, 5).host, 'c');
});

test('assignProxy: cycles when accounts exceed proxies*N', () => {
  const proxies = [{ host: 'a' }, { host: 'b' }];
  assert.equal(assignProxy(0, proxies, 5).host, 'a');
  assert.equal(assignProxy(5, proxies, 5).host, 'b');
  assert.equal(assignProxy(10, proxies, 5).host, 'a');
  assert.equal(assignProxy(15, proxies, 5).host, 'b');
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

Create `sender.js`:

```js
export function assignProxy(index, proxies, accountsPerProxy) {
  if (!proxies?.length) return null;
  const group = Math.floor(index / accountsPerProxy);
  return proxies[group % proxies.length];
}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add sender.js test/sender.test.js
git commit -m "feat(sender): proxy assignment helper"
```

---

## Task 10: sender.js — Job Orchestrator

**Files:**
- Modify: `sender.js`, `test/sender.test.js`

- [ ] **Step 1: Write failing test (basic happy path)**

Append to `test/sender.test.js`:

```js
import { createSender } from '../sender.js';

const settings = { channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: 0, concurrency: 2 };

function deferred() {
  let resolve;
  const p = new Promise(r => { resolve = r; });
  return { p, resolve };
}

test('createSender: happy path runs all accounts and emits done', async () => {
  const sendOne = async (a) => ({ ok: true, durationMs: 1 });
  const sender = createSender({ sendOne });
  const events = [];
  const accounts = [{ login: 'a', oauthToken: 'oauth:1' }, { login: 'b', oauthToken: 'oauth:2' }];
  const { jobId } = sender.start({ accounts, proxies: [], settings });
  sender.subscribe(jobId, (e) => events.push(e));
  await new Promise(r => setTimeout(r, 50));
  const done = events.find(e => e.type === 'done');
  assert.ok(done, 'done event emitted');
  assert.equal(done.summary.total, 2);
  assert.equal(done.summary.ok, 2);
});

test('createSender: rejects second start while running', async () => {
  let release;
  const blocker = new Promise(r => { release = r; });
  const sendOne = async () => { await blocker; return { ok: true, durationMs: 1 }; };
  const sender = createSender({ sendOne });
  sender.start({ accounts: [{ login: 'a', oauthToken: 'oauth:1' }], proxies: [], settings });
  assert.throws(() => sender.start({ accounts: [], proxies: [], settings }), /running/);
  release();
});

test('createSender: respects concurrency', async () => {
  let inFlight = 0, peak = 0;
  const sendOne = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 20));
    inFlight--;
    return { ok: true, durationMs: 20 };
  };
  const sender = createSender({ sendOne });
  const accounts = Array.from({ length: 6 }, (_, i) => ({ login: 'a' + i, oauthToken: 'oauth:' + i }));
  sender.start({ accounts, proxies: [], settings: { ...settings, concurrency: 2 } });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(peak, 2);
});

test('createSender: failed results captured for retry', async () => {
  let n = 0;
  const sendOne = async () => (++n % 2 === 0 ? { ok: false, error: 'x', durationMs: 1 } : { ok: true, durationMs: 1 });
  const sender = createSender({ sendOne });
  const accounts = Array.from({ length: 4 }, (_, i) => ({ login: 'a' + i, oauthToken: 'oauth:' + i }));
  const { jobId } = sender.start({ accounts, proxies: [], settings });
  await new Promise(r => setTimeout(r, 80));
  const failed = sender.getFailedLogins(jobId);
  assert.equal(failed.length, 2);
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement orchestrator**

Replace `sender.js`:

```js
import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';

export function assignProxy(index, proxies, accountsPerProxy) {
  if (!proxies?.length) return null;
  const group = Math.floor(index / accountsPerProxy);
  return proxies[group % proxies.length];
}

export function createSender({ sendOne }) {
  let currentJob = null;
  const listenersByJob = new Map();

  function emit(jobId, event) {
    const set = listenersByJob.get(jobId);
    if (!set) return;
    for (const fn of set) {
      try { fn(event); } catch {}
    }
  }

  function start({ accounts, proxies, settings }) {
    if (currentJob && currentJob.status === 'running') {
      throw new Error('JobAlreadyRunning: another job is running');
    }
    const jobId = randomUUID();
    const job = {
      jobId,
      status: 'running',
      results: [],
      settings,
      startedAt: Date.now()
    };
    currentJob = job;
    listenersByJob.set(jobId, new Set());

    const limit = pLimit(Math.max(1, settings.concurrency || 1));
    const interval = (settings.spreadSeconds * 1000) / Math.max(1, accounts.length);

    const tasks = accounts.map((account, i) => {
      const proxy = assignProxy(i, proxies, settings.accountsPerProxy);
      const proxyLabel = proxy ? `${proxy.host}:${proxy.port}` : 'direct';
      const delay = i * interval;
      return new Promise((resolve) => {
        setTimeout(() => {
          limit(async () => {
            emit(jobId, { type: 'sending', login: account.login, proxy: proxyLabel });
            const result = await sendOne(account, proxy, settings.channel, settings.word);
            const entry = { login: account.login, proxy: proxyLabel, ...result };
            job.results.push(entry);
            emit(jobId, { type: 'progress', login: account.login, proxy: proxyLabel, result });
          }).then(resolve, resolve);
        }, delay);
      });
    });

    Promise.all(tasks).then(() => {
      job.status = 'done';
      const ok = job.results.filter(r => r.ok).length;
      const summary = { total: accounts.length, ok, failed: accounts.length - ok };
      emit(jobId, { type: 'done', jobId, summary });
      setTimeout(() => {
        listenersByJob.delete(jobId);
        if (currentJob?.jobId === jobId) currentJob = null;
      }, 5 * 60 * 1000);
    });

    return { jobId };
  }

  function subscribe(jobId, listener) {
    const set = listenersByJob.get(jobId);
    if (!set) return () => {};
    set.add(listener);
    return () => set.delete(listener);
  }

  function getSnapshot(jobId) {
    if (!currentJob || currentJob.jobId !== jobId) return null;
    return {
      jobId,
      status: currentJob.status,
      results: [...currentJob.results]
    };
  }

  function getFailedLogins(jobId) {
    if (!currentJob || currentJob.jobId !== jobId) return [];
    return currentJob.results.filter(r => !r.ok).map(r => r.login);
  }

  function isRunning() {
    return currentJob?.status === 'running';
  }

  function lastJobId() {
    return currentJob?.jobId ?? null;
  }

  return { start, subscribe, getSnapshot, getFailedLogins, isRunning, lastJobId };
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npm test
```
Expected: all sender tests passing.

- [ ] **Step 5: Commit**

```bash
git add sender.js test/sender.test.js
git commit -m "feat(sender): job orchestrator with scheduling, concurrency, events"
```

---

## Task 11: csrf.js — Origin/Referer Check Middleware

**Files:**
- Create: `csrf.js`, `test/csrf.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/csrf.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCsrfMiddleware } from '../csrf.js';

function res() {
  let body, status;
  return { status: (s) => ({ json: (b) => { status = s; body = b; } }), _get: () => ({ status, body }) };
}

test('csrf: GET passes without origin', () => {
  const mw = makeCsrfMiddleware({ expectedOrigin: 'https://example.com' });
  let next = false;
  mw({ method: 'GET', headers: {} }, res(), () => next = true);
  assert.equal(next, true);
});

test('csrf: POST with matching origin passes', () => {
  const mw = makeCsrfMiddleware({ expectedOrigin: 'https://example.com' });
  let next = false;
  mw({ method: 'POST', headers: { origin: 'https://example.com' } }, res(), () => next = true);
  assert.equal(next, true);
});

test('csrf: POST with mismatched origin 403s', () => {
  const mw = makeCsrfMiddleware({ expectedOrigin: 'https://example.com' });
  const r = res();
  mw({ method: 'POST', headers: { origin: 'https://evil.com' } }, r, () => {});
  assert.equal(r._get().status, 403);
});

test('csrf: POST without origin or referer 403s', () => {
  const mw = makeCsrfMiddleware({ expectedOrigin: 'https://example.com' });
  const r = res();
  mw({ method: 'POST', headers: {} }, r, () => {});
  assert.equal(r._get().status, 403);
});

test('csrf: falls back to referer host check', () => {
  const mw = makeCsrfMiddleware({ expectedOrigin: 'https://example.com' });
  let next = false;
  mw({ method: 'PUT', headers: { referer: 'https://example.com/page' } }, res(), () => next = true);
  assert.equal(next, true);
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement**

```js
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function makeCsrfMiddleware({ expectedOrigin }) {
  return function csrfMw(req, res, next) {
    if (!MUTATING.has(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      if (origin === expectedOrigin) return next();
      return res.status(403).json({ error: 'csrf_origin_mismatch' });
    }
    const referer = req.headers.referer;
    if (referer && referer.startsWith(expectedOrigin + '/')) return next();
    if (referer === expectedOrigin) return next();
    return res.status(403).json({ error: 'csrf_no_origin' });
  };
}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add csrf.js test/csrf.test.js
git commit -m "feat(csrf): Origin/Referer middleware"
```

---

## Task 12: views/ — HTML Templates

**Files:**
- Create: `views/layout.js`, `views/login.js`, `views/main.js`, `views/accounts.js`, `views/proxies.js`, `views/settings.js`

These are pure functions returning HTML strings. No tests — exercised end-to-end via routes.

- [ ] **Step 1: Create `views/layout.js`**

```js
export function layout({ title, body, active }) {
  const link = (href, label) =>
    `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`;
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${title} — Twitch Sender</title>
<link rel="stylesheet" href="/style.css">
</head><body>
<nav>
  ${link('/', 'Send')}
  ${link('/accounts', 'Accounts')}
  ${link('/proxies', 'Proxies')}
  ${link('/settings', 'Settings')}
  <a href="/logout" class="right">Logout</a>
</nav>
<main>${body}</main>
<script src="/app.js"></script>
</body></html>`;
}
```

- [ ] **Step 2: Create `views/login.js`**

```js
export function loginPage({ error } = {}) {
  return `<!doctype html><html><head>
<meta charset="utf-8"><title>Login</title>
<link rel="stylesheet" href="/style.css">
</head><body class="centered">
<form method="post" action="/login" class="login">
  <h1>Twitch Sender</h1>
  <input type="password" name="password" placeholder="Password" required autofocus>
  <button type="submit">Login</button>
  ${error ? `<p class="error">${error}</p>` : ''}
</form>
</body></html>`;
}
```

- [ ] **Step 3: Create `views/main.js`**

```js
import { layout } from './layout.js';

export function mainPage({ settings, counts }) {
  const body = `
<h1>Send</h1>
<section class="summary">
  <div><strong>Channel:</strong> #${settings.channel || '—'}</div>
  <div><strong>Word:</strong> ${settings.word || '—'}</div>
  <div><strong>Accounts:</strong> ${counts.accounts}</div>
  <div><strong>Proxies:</strong> ${counts.proxies} (${settings.accountsPerProxy}/proxy)</div>
  <div><strong>Spread:</strong> ${settings.spreadSeconds}s</div>
  <div><strong>Concurrency:</strong> ${settings.concurrency}</div>
  <a href="/settings">Edit</a>
</section>
<button id="send-btn">Send</button>
<button id="retry-btn" hidden>Retry failed</button>
<table id="progress"><thead><tr><th>Login</th><th>Status</th><th>Proxy</th><th>Duration</th><th>Error</th></tr></thead><tbody></tbody></table>
<p id="summary"></p>`;
  return layout({ title: 'Send', body, active: '/' });
}
```

- [ ] **Step 4: Create `views/accounts.js`, `views/proxies.js`, `views/settings.js`**

`views/accounts.js`:

```js
import { layout } from './layout.js';
export function accountsPage() {
  const body = `
<h1>Accounts</h1>
<p>Format on import: <code>login<TAB>oauth:token</code> per line.</p>
<table id="accounts-table"><thead><tr><th>Login</th><th>Token</th><th></th></tr></thead><tbody></tbody></table>
<button id="add-row">+ Row</button>
<textarea id="bulk-import" placeholder="Paste TSV here (login<TAB>oauth:token per line)"></textarea>
<button id="import-bulk">Import</button>
<button id="save">Save</button>
<p id="status"></p>`;
  return layout({ title: 'Accounts', body, active: '/accounts' });
}
```

`views/proxies.js`:

```js
import { layout } from './layout.js';
export function proxiesPage() {
  const body = `
<h1>Proxies (SOCKS5)</h1>
<p>Format on import: <code>host:port</code> or <code>host:port:user:pass</code> per line.</p>
<table id="proxies-table"><thead><tr><th>Host</th><th>Port</th><th>User</th><th>Pass</th><th></th></tr></thead><tbody></tbody></table>
<button id="add-row">+ Row</button>
<textarea id="bulk-import" placeholder="Paste lines here"></textarea>
<button id="import-bulk">Import</button>
<button id="save">Save</button>
<p id="status"></p>`;
  return layout({ title: 'Proxies', body, active: '/proxies' });
}
```

`views/settings.js`:

```js
import { layout } from './layout.js';
export function settingsPage() {
  const body = `
<h1>Settings</h1>
<form id="settings-form">
  <label>Channel <input name="channel" required></label>
  <label>Word <input name="word" required></label>
  <label>Accounts per proxy <input type="number" name="accountsPerProxy" min="1" value="5"></label>
  <label>Spread seconds <input type="number" name="spreadSeconds" min="0" value="0"></label>
  <label>Concurrency <input type="number" name="concurrency" min="1" value="5"></label>
  <button type="submit">Save</button>
</form>
<p id="status"></p>`;
  return layout({ title: 'Settings', body, active: '/settings' });
}
```

- [ ] **Step 5: Create `public/style.css`**

```css
:root { color-scheme: dark; --bg:#101216; --fg:#dbe1e8; --accent:#a970ff; --muted:#7a8290; --danger:#ff6b6b; --ok:#6bff95; }
* { box-sizing: border-box; }
body { margin:0; font:14px system-ui,sans-serif; background:var(--bg); color:var(--fg); }
nav { display:flex; gap:1rem; padding:.75rem 1.25rem; background:#1a1d24; border-bottom:1px solid #232830; }
nav a { color:var(--fg); text-decoration:none; padding:.25rem .5rem; border-radius:4px; }
nav a.active, nav a:hover { background:var(--accent); color:#fff; }
nav .right { margin-left:auto; }
main { max-width:900px; margin:0 auto; padding:1.5rem; }
h1 { font-size:1.4rem; margin:0 0 1rem; }
button { background:var(--accent); color:#fff; border:0; padding:.5rem 1rem; border-radius:4px; cursor:pointer; font:inherit; }
button:hover { filter:brightness(1.1); }
button:disabled { opacity:.5; cursor:not-allowed; }
input, textarea { background:#1a1d24; color:var(--fg); border:1px solid #2a2f38; border-radius:4px; padding:.4rem .6rem; font:inherit; }
textarea { width:100%; min-height:6rem; margin:.5rem 0; }
table { width:100%; border-collapse:collapse; margin:1rem 0; }
th, td { text-align:left; padding:.4rem .5rem; border-bottom:1px solid #232830; }
.error { color:var(--danger); }
.ok { color:var(--ok); }
.summary { display:grid; grid-template-columns: repeat(auto-fill, minmax(180px,1fr)); gap:.5rem; margin-bottom:1rem; padding:.75rem; background:#1a1d24; border-radius:6px; }
.centered { display:flex; min-height:100vh; align-items:center; justify-content:center; }
.login { display:flex; flex-direction:column; gap:.75rem; min-width:260px; padding:1.5rem; background:#1a1d24; border-radius:8px; }
label { display:flex; flex-direction:column; gap:.25rem; margin:.5rem 0; }
form { display:flex; flex-direction:column; gap:.5rem; max-width:400px; }
```

- [ ] **Step 6: Commit**

```bash
git add views/ public/style.css
git commit -m "feat(views): HTML templates and base stylesheet"
```

---

## Task 13: server.js + routes/pages.js — Bootstrap + Pages

**Files:**
- Create: `server.js`, `routes/pages.js`

- [ ] **Step 1: Create `routes/pages.js`**

```js
import { Router } from 'express';
import { loginPage } from '../views/login.js';
import { mainPage } from '../views/main.js';
import { accountsPage } from '../views/accounts.js';
import { proxiesPage } from '../views/proxies.js';
import { settingsPage } from '../views/settings.js';

export function pagesRouter({ store, requireAuth }) {
  const r = Router();

  r.get('/login', (req, res) => res.type('html').send(loginPage()));

  r.get('/', requireAuth, async (req, res) => {
    const [settings, accounts, proxies] = await Promise.all([
      store.read('settings'), store.read('accounts'), store.read('proxies')
    ]);
    res.type('html').send(mainPage({ settings, counts: { accounts: accounts.length, proxies: proxies.length } }));
  });

  r.get('/accounts', requireAuth, (req, res) => res.type('html').send(accountsPage()));
  r.get('/proxies', requireAuth, (req, res) => res.type('html').send(proxiesPage()));
  r.get('/settings', requireAuth, (req, res) => res.type('html').send(settingsPage()));

  return r;
}
```

- [ ] **Step 2: Create `server.js`**

```js
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import { Store } from './store.js';
import { makeMiddleware, verifyPassword, buildCookie, COOKIE_NAME } from './auth.js';
import { makeCsrfMiddleware } from './csrf.js';
import { createSender } from './sender.js';
import { sendOne } from './twitch.js';
import { pagesRouter } from './routes/pages.js';
import { apiRouter } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  PORT = 3000,
  APP_PASSWORD_HASH,
  SESSION_SECRET,
  COOKIE_DAYS = 7,
  PUBLIC_ORIGIN
} = process.env;

if (!APP_PASSWORD_HASH || !SESSION_SECRET) {
  console.error('APP_PASSWORD_HASH and SESSION_SECRET are required in .env');
  process.exit(1);
}

const cookieMaxAgeMs = Number(COOKIE_DAYS) * 86_400_000;
const store = new Store(path.join(__dirname, 'data'));
const sender = createSender({ sendOne });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

// Cookie parser (minimal)
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      req.cookies[k] = decodeURIComponent(v.join('='));
    }
  }
  next();
});

const requireAuth = makeMiddleware({ secret: SESSION_SECRET, cookieMaxAgeMs });
const csrf = PUBLIC_ORIGIN ? makeCsrfMiddleware({ expectedOrigin: PUBLIC_ORIGIN }) : (req, res, next) => next();

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });

// Public auth endpoints
app.post('/login', loginLimiter, async (req, res) => {
  const password = req.body?.password;
  if (typeof password !== 'string') return res.redirect('/login');
  if (await verifyPassword(password, APP_PASSWORD_HASH)) {
    const cookie = buildCookie(SESSION_SECRET);
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(cookieMaxAgeMs / 1000)}${PUBLIC_ORIGIN?.startsWith('https://') ? '; Secure' : ''}`);
    return res.redirect('/');
  }
  res.status(401).type('html').send('<p>Wrong password. <a href="/login">try again</a></p>');
});
app.use(express.urlencoded({ extended: false }));
app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.redirect('/login');
});

// Static
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use(pagesRouter({ store, requireAuth }));
app.use('/api', requireAuth, csrf, apiRouter({ store, sender }));

app.listen(PORT, '127.0.0.1', () => console.log(`listening http://127.0.0.1:${PORT}`));
```

- [ ] **Step 3: Create local `.env` (don't start yet)**

```bash
cp .env.example .env
# Then edit .env and fill in:
#   APP_PASSWORD_HASH  → run: npm run hash -- yourpassword  (paste the printed hash)
#   SESSION_SECRET     → run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Don't run `npm start` yet** — `routes/api.js` is created in Task 14. We'll smoke-test after Task 17.

- [ ] **Step 4: Commit**

```bash
git add server.js routes/pages.js
git commit -m "feat(server): Express bootstrap + login/logout + pages"
```

---

## Task 14: routes/api.js — CRUD Endpoints + Tests

**Files:**
- Create: `routes/api.js`, `test/api.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/api.test.js`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../store.js';
import { createSender } from '../sender.js';
import { apiRouter } from '../routes/api.js';

function buildApp(store, sender) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ store, sender }));
  return app;
}

let store, sender, app, dir;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'api-'));
  store = new Store(dir);
  sender = createSender({ sendOne: async () => ({ ok: true, durationMs: 1 }) });
  app = buildApp(store, sender);
});

test('GET /api/accounts returns []', async () => {
  const r = await request(app).get('/api/accounts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('PUT /api/accounts saves valid data', async () => {
  const r = await request(app).put('/api/accounts')
    .send([{ login: 'u', oauthToken: 'oauth:' + 'x'.repeat(30) }]);
  assert.equal(r.status, 204);
  const r2 = await request(app).get('/api/accounts');
  assert.equal(r2.body.length, 1);
});

test('PUT /api/accounts rejects invalid data', async () => {
  const r = await request(app).put('/api/accounts').send([{ login: '!bad' }]);
  assert.equal(r.status, 400);
  assert.ok(Array.isArray(r.body.errors));
});

test('GET/PUT /api/proxies works', async () => {
  await request(app).put('/api/proxies').send([{ host: '1.2.3.4', port: 1080 }]).expect(204);
  const r = await request(app).get('/api/proxies');
  assert.equal(r.body[0].host, '1.2.3.4');
});

test('GET/PUT /api/settings works', async () => {
  await request(app).put('/api/settings').send({
    channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: 0, concurrency: 5
  }).expect(204);
  const r = await request(app).get('/api/settings');
  assert.equal(r.body.channel, 'c');
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Implement CRUD in `routes/api.js`**

```js
import { Router } from 'express';
import { validateAccounts, validateProxies, validateSettings } from '../store.js';

export function apiRouter({ store, sender }) {
  const r = Router();

  const crud = (name, validate) => {
    r.get(`/${name}`, async (req, res) => res.json(await store.read(name)));
    r.put(`/${name}`, async (req, res) => {
      const errors = validate(req.body);
      if (errors.length) return res.status(400).json({ errors });
      await store.write(name, req.body);
      res.status(204).end();
    });
  };
  crud('accounts', validateAccounts);
  crud('proxies', validateProxies);
  crud('settings', validateSettings);

  return r;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add routes/api.js test/api.test.js
git commit -m "feat(api): CRUD endpoints for accounts, proxies, settings"
```

---

## Task 15: routes/api.js — POST /api/send + Tests

**Files:**
- Modify: `routes/api.js`, `test/api.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/api.test.js`:

```js
async function setupForSend() {
  await request(app).put('/api/accounts').send([
    { login: 'u1', oauthToken: 'oauth:' + 'x'.repeat(30) }
  ]).expect(204);
  await request(app).put('/api/settings').send({
    channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: 0, concurrency: 5
  }).expect(204);
}

test('POST /api/send returns jobId 202', async () => {
  await setupForSend();
  const r = await request(app).post('/api/send').send({});
  assert.equal(r.status, 202);
  assert.ok(r.body.jobId);
});

test('POST /api/send 400 when accounts empty', async () => {
  const r = await request(app).post('/api/send').send({});
  assert.equal(r.status, 400);
});

test('POST /api/send 409 when one already running', async () => {
  const blocker = new Promise(r => setTimeout(r, 200));
  const slowSender = createSender({ sendOne: async () => { await blocker; return { ok: true, durationMs: 200 }; } });
  const app2 = buildApp(store, slowSender);
  await request(app2).put('/api/accounts').send([{ login: 'u', oauthToken: 'oauth:' + 'x'.repeat(30) }]).expect(204);
  await request(app2).put('/api/settings').send({ channel:'c', word:'w', accountsPerProxy:5, spreadSeconds:0, concurrency:1 }).expect(204);
  await request(app2).post('/api/send').send({}).expect(202);
  const second = await request(app2).post('/api/send').send({});
  assert.equal(second.status, 409);
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Add to `routes/api.js`**

Append to the `apiRouter` body before `return r`:

```js
  r.post('/send', async (req, res) => {
    const [accounts, proxies, settings] = await Promise.all([
      store.read('accounts'), store.read('proxies'), store.read('settings')
    ]);
    if (!accounts.length) return res.status(400).json({ error: 'no_accounts' });
    if (!settings.channel) return res.status(400).json({ error: 'no_channel' });
    if (!settings.word) return res.status(400).json({ error: 'no_word' });
    try {
      const { jobId } = sender.start({ accounts, proxies, settings });
      res.status(202).json({ jobId });
    } catch (err) {
      if (/JobAlreadyRunning/.test(err.message)) return res.status(409).json({ error: 'job_running', jobId: sender.lastJobId() });
      throw err;
    }
  });

  r.post('/send/retry-failed', async (req, res) => {
    const [accountsAll, proxies, settings] = await Promise.all([
      store.read('accounts'), store.read('proxies'), store.read('settings')
    ]);
    const lastId = sender.lastJobId();
    if (!lastId) return res.status(400).json({ error: 'no_previous_job' });
    const failedLogins = sender.getFailedLogins(lastId);
    if (!failedLogins.length) return res.status(400).json({ error: 'no_failed' });
    const accounts = accountsAll.filter(a => failedLogins.includes(a.login));
    if (!accounts.length) return res.status(400).json({ error: 'no_failed' });
    try {
      const { jobId } = sender.start({ accounts, proxies, settings });
      res.status(202).json({ jobId });
    } catch (err) {
      if (/JobAlreadyRunning/.test(err.message)) return res.status(409).json({ error: 'job_running' });
      throw err;
    }
  });
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add routes/api.js test/api.test.js
git commit -m "feat(api): POST /api/send and retry-failed"
```

---

## Task 16: routes/api.js — SSE /api/progress

**Files:**
- Modify: `routes/api.js`, `test/api.test.js`

- [ ] **Step 1: Write failing test**

Add `import http from 'node:http';` to the top imports of `test/api.test.js`, then append:

```js
test('GET /api/progress streams events', async () => {
  await setupForSend();
  const startRes = await request(app).post('/api/send').send({});
  const jobId = startRes.body.jobId;
  const got = await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/api/progress?jobId=${jobId}`, method: 'GET'
      }, (res) => {
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString();
          if (buf.includes('event: done')) {
            req.destroy();
            server.close();
            resolve(buf);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  });
  assert.match(got, /event: done/);
});
```

- [ ] **Step 2: Run, verify fail**

- [ ] **Step 3: Add SSE handler to `routes/api.js`**

Append in `apiRouter` before `return r`:

```js
  r.get('/progress', (req, res) => {
    const jobId = req.query.jobId;
    if (!jobId) return res.status(400).json({ error: 'jobId required' });

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();

    const snapshot = sender.getSnapshot(jobId);
    if (snapshot) {
      for (const r of snapshot.results) {
        res.write(`event: progress\ndata: ${JSON.stringify({ login: r.login, proxy: r.proxy, result: { ok: r.ok, error: r.error, durationMs: r.durationMs } })}\n\n`);
      }
      if (snapshot.status === 'done') {
        const ok = snapshot.results.filter(r => r.ok).length;
        const total = snapshot.results.length;
        res.write(`event: done\ndata: ${JSON.stringify({ jobId, summary: { total, ok, failed: total - ok } })}\n\n`);
        return res.end();
      }
    }

    const unsubscribe = sender.subscribe(jobId, (event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done') {
        res.end();
      }
    });

    req.on('close', () => unsubscribe());
  });
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add routes/api.js test/api.test.js
git commit -m "feat(api): SSE /api/progress"
```

---

## Task 17: public/app.js — Client Logic

**Files:**
- Create: `public/app.js`

No automated tests — covered by manual smoke. Keep logic simple.

- [ ] **Step 1: Create `public/app.js`**

```js
// Detect page by element presence
const $ = (sel) => document.querySelector(sel);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

function setStatus(text, ok = true) {
  const el = $('#status');
  if (el) { el.textContent = text; el.className = ok ? 'ok' : 'error'; }
}

// ===== Accounts page =====
if ($('#accounts-table')) {
  const tbody = $('#accounts-table tbody');
  const addRow = (a = { login: '', oauthToken: '' }) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input class="login" value="${a.login || ''}"></td>
      <td><input class="token" value="${a.oauthToken || ''}" type="password"></td>
      <td><button class="del">×</button></td>`;
    tr.querySelector('.del').onclick = () => tr.remove();
    tbody.appendChild(tr);
  };
  api('GET', '/api/accounts').then(rows => (rows || []).forEach(addRow));
  $('#add-row').onclick = () => addRow();
  $('#import-bulk').onclick = () => {
    const lines = $('#bulk-import').value.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const [login, token] = line.split(/\s+/, 2);
      if (login && token) addRow({ login, oauthToken: token });
    }
    $('#bulk-import').value = '';
  };
  $('#save').onclick = async () => {
    const rows = Array.from(tbody.querySelectorAll('tr')).map(tr => ({
      login: tr.querySelector('.login').value.trim(),
      oauthToken: tr.querySelector('.token').value.trim()
    }));
    const res = await fetch('/api/accounts', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify(rows) });
    if (res.status === 204) setStatus('Saved', true);
    else { const e = await res.json(); setStatus('Errors: ' + e.errors.join('; '), false); }
  };
}

// ===== Proxies page =====
if ($('#proxies-table')) {
  const tbody = $('#proxies-table tbody');
  const addRow = (p = {}) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input class="host" value="${p.host || ''}"></td>
      <td><input class="port" type="number" value="${p.port || ''}"></td>
      <td><input class="user" value="${p.username || ''}"></td>
      <td><input class="pass" value="${p.password || ''}" type="password"></td>
      <td><button class="del">×</button></td>`;
    tr.querySelector('.del').onclick = () => tr.remove();
    tbody.appendChild(tr);
  };
  api('GET', '/api/proxies').then(rows => (rows || []).forEach(addRow));
  $('#add-row').onclick = () => addRow();
  $('#import-bulk').onclick = () => {
    const lines = $('#bulk-import').value.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length < 2) continue;
      addRow({ host: parts[0], port: Number(parts[1]), username: parts[2] || '', password: parts[3] || '' });
    }
    $('#bulk-import').value = '';
  };
  $('#save').onclick = async () => {
    const rows = Array.from(tbody.querySelectorAll('tr')).map(tr => {
      const o = {
        host: tr.querySelector('.host').value.trim(),
        port: Number(tr.querySelector('.port').value)
      };
      const u = tr.querySelector('.user').value.trim();
      const p = tr.querySelector('.pass').value;
      if (u) o.username = u;
      if (p) o.password = p;
      return o;
    });
    const res = await fetch('/api/proxies', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify(rows) });
    if (res.status === 204) setStatus('Saved', true);
    else { const e = await res.json(); setStatus('Errors: ' + e.errors.join('; '), false); }
  };
}

// ===== Settings page =====
if ($('#settings-form')) {
  const form = $('#settings-form');
  api('GET', '/api/settings').then(s => {
    if (!s) return;
    form.channel.value = s.channel;
    form.word.value = s.word;
    form.accountsPerProxy.value = s.accountsPerProxy;
    form.spreadSeconds.value = s.spreadSeconds;
    form.concurrency.value = s.concurrency;
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      channel: form.channel.value.trim(),
      word: form.word.value,
      accountsPerProxy: Number(form.accountsPerProxy.value),
      spreadSeconds: Number(form.spreadSeconds.value),
      concurrency: Number(form.concurrency.value)
    };
    const res = await fetch('/api/settings', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
    if (res.status === 204) setStatus('Saved', true);
    else { const e = await res.json(); setStatus('Errors: ' + e.errors.join('; '), false); }
  };
}

// ===== Main page =====
if ($('#send-btn')) {
  const btn = $('#send-btn');
  const retry = $('#retry-btn');
  const tbody = $('#progress tbody');
  const summary = $('#summary');
  const rowFor = (login) => {
    let tr = tbody.querySelector(`tr[data-login="${CSS.escape(login)}"]`);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.login = login;
      tr.innerHTML = `<td>${login}</td><td>pending</td><td>—</td><td>—</td><td></td>`;
      tbody.appendChild(tr);
    }
    return tr;
  };
  function attachSSE(jobId) {
    const es = new EventSource('/api/progress?jobId=' + encodeURIComponent(jobId));
    es.addEventListener('sending', (e) => {
      const { login, proxy } = JSON.parse(e.data);
      const tr = rowFor(login);
      tr.children[1].textContent = 'sending';
      tr.children[2].textContent = proxy;
    });
    es.addEventListener('progress', (e) => {
      const { login, proxy, result } = JSON.parse(e.data);
      const tr = rowFor(login);
      tr.children[1].textContent = result.ok ? 'ok' : 'failed';
      tr.children[1].className = result.ok ? 'ok' : 'error';
      tr.children[2].textContent = proxy;
      tr.children[3].textContent = (result.durationMs ?? '—') + 'ms';
      tr.children[4].textContent = result.error || '';
    });
    es.addEventListener('done', (e) => {
      const { summary: s } = JSON.parse(e.data);
      summary.textContent = `Done: ${s.ok}/${s.total} ok, ${s.failed} failed`;
      btn.disabled = false;
      if (s.failed > 0) retry.hidden = false;
      es.close();
    });
  }
  btn.onclick = async () => {
    btn.disabled = true;
    tbody.innerHTML = '';
    summary.textContent = '';
    retry.hidden = true;
    const r = await fetch('/api/send', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' });
    if (r.status === 202) {
      const { jobId } = await r.json();
      attachSSE(jobId);
    } else if (r.status === 409) {
      const body = await r.json();
      if (body.jobId) attachSSE(body.jobId);
      else { summary.textContent = 'A job is already running.'; btn.disabled = false; }
    } else {
      const body = await r.json().catch(() => ({}));
      summary.textContent = 'Error: ' + (body.error || r.status);
      btn.disabled = false;
    }
  };
  retry.onclick = async () => {
    retry.hidden = true;
    btn.disabled = true;
    tbody.innerHTML = '';
    summary.textContent = '';
    const r = await fetch('/api/send/retry-failed', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' });
    if (r.status === 202) {
      const { jobId } = await r.json();
      attachSSE(jobId);
    } else {
      const body = await r.json().catch(() => ({}));
      summary.textContent = 'Error: ' + (body.error || r.status);
      btn.disabled = false;
    }
  };
}
```

- [ ] **Step 2: Manual smoke**

```bash
npm start
```

Open `http://127.0.0.1:3000/login`, log in, navigate through pages. No accounts/proxies/settings yet; pages should load empty. Save a test account and verify it appears after reload.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat(public): client-side logic for all pages"
```

---

## Task 18: Deploy Artifacts

**Files:**
- Create: `Caddyfile.example`, `systemd/twitch-sender.service`, `README.md`

- [ ] **Step 1: Create `Caddyfile.example`**

```
yourdomain.example.com {
    reverse_proxy 127.0.0.1:3000
    encode gzip
    log {
        output file /var/log/caddy/twitch-sender.log
    }
}
```

- [ ] **Step 2: Create `systemd/twitch-sender.service`**

```ini
[Unit]
Description=Twitch Multi-Sender
After=network.target

[Service]
Type=simple
User=tms
WorkingDirectory=/opt/twitch-sender
EnvironmentFile=/opt/twitch-sender/.env
ExecStart=/usr/bin/node /opt/twitch-sender/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Create `README.md`**

````markdown
# Twitch Multi-Sender

Send one message from N Twitch accounts to a channel via SOCKS5 proxies.

## Local dev

```bash
npm install
npm run hash -- your-password    # paste into .env as APP_PASSWORD_HASH
openssl rand -hex 32             # paste into .env as SESSION_SECRET
npm start
# open http://127.0.0.1:3000
```

## VPS deploy

1. `useradd -m tms && mkdir -p /opt/twitch-sender && chown tms:tms /opt/twitch-sender`
2. As `tms`: clone repo, `npm ci --omit=dev`, fill in `.env` (set `PUBLIC_ORIGIN=https://yourdomain.example.com`)
3. `cp systemd/twitch-sender.service /etc/systemd/system/` (edit user/path if needed)
4. `systemctl daemon-reload && systemctl enable --now twitch-sender`
5. Install Caddy, copy `Caddyfile.example` to `/etc/caddy/Caddyfile` (replace domain), `systemctl reload caddy`
6. Browse to your domain, log in, fill in accounts/proxies/settings, click Send.

## Notes

- Tokens (`chat:edit` scope) can be obtained via https://twitchtokengenerator.com or a custom OAuth flow.
- Twitch ToS forbids artificial chat activity — running this risks account bans. Use at your own discretion.
- Settings are stored unencrypted in `./data/*.json` (chmod 600 by the `tms` user). Take backups.
````

- [ ] **Step 4: Commit**

```bash
git add Caddyfile.example systemd/ README.md
git commit -m "docs: deploy artifacts and README"
```

---

## Task 19: Manual Smoke Test (Final Verification)

**Files:** None (manual procedure)

- [ ] **Step 1: Local smoke without real Twitch**

```bash
npm start
```
Open `http://127.0.0.1:3000`, log in. Verify:
- Nav links work, pages render.
- Save 1 fake account (`login=foo`, `oauthToken=oauth:` + 30 chars), 1 fake proxy, settings (channel=test, word=hi).
- Click Send. With fake credentials, expect `proxy_unreachable` or `twitch_unreachable` within ~15s. UI shows failed row + retry button.

- [ ] **Step 2: Local smoke with one real test account, no proxy**

- Delete proxies (empty list).
- Use a real OAuth token (`chat:edit` scope) for a throwaway account, pointed at a test channel you control.
- Send. Expect `ok` and message visible in the channel within ~1s.

- [ ] **Step 3: Local smoke with one real test account + working SOCKS5**

- Add a real working SOCKS5 proxy.
- Send. Expect `ok`. Verify in your channel logs that the message came in.

- [ ] **Step 4: Deploy to VPS, repeat steps 1–3 against the deployed domain.**

- Verify HTTPS works.
- Verify rate-limit on `/login` (try 6 wrong passwords → 6th is rate-limited).
- Verify state survives systemd restart (data persists, no in-flight job — expected).

- [ ] **Step 5: Tag release**

```bash
git tag v0.1.0
```

---

## Self-Review Notes

This plan covers all spec sections: storage (task 2-3), auth (4-6), IRC layer (7-8), orchestrator (9-10), CSRF (11), views (12), bootstrap+pages (13), API CRUD (14), send (15), SSE (16), client (17), deploy (18), manual smoke (19).

**Known scope omissions (intentional, per spec section 14):**
- No automated UI/E2E tests (manual smoke only).
- No real-Twitch automated tests (CI-hostile).
- No token-refresh, no proxy health-check, no persistent jobs.

**Total estimated effort:** 19 tasks × ~10 min each = ~3 hours of focused work for a competent Node developer.
