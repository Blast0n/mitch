# Proxy Health Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand SOCKS5 health check for proxies — manual button on `/proxies`, in-memory status map, warn-but-proceed confirm before `/send`.

**Architecture:** New isolated module `proxyHealth.js` runs a SOCKS5 + TCP-reach probe against `irc-ws.chat.twitch.tv:443` (no WS, no IRC, no Twitch accounts). Results live in a new in-memory `healthStore.js` keyed by `host:port|user|pass`. Two new API endpoints (`POST /api/proxies/check`, `GET /api/proxies/health`) expose probe and dump. `ProxiesPage` adds a status column + check buttons; `MainPage` adds a `window.confirm` preflight before kicking off `/send`. Existing `sender.js` / `twitch.js` / `store.js` / `proxies.json` are unchanged.

**Tech Stack:** Existing — Express, `node:test`, `supertest`, React + Vite, shadcn/lucide-react. One new direct dependency: `socks` (already transitive via `socks-proxy-agent`).

**Spec:** [`docs/superpowers/specs/2026-05-28-proxy-health-check-design.md`](../specs/2026-05-28-proxy-health-check-design.md)

---

## File Structure

```
package.json                       # MODIFY — add "socks" to dependencies
healthStore.js                     # CREATE — in-memory health map factory
proxyHealth.js                     # CREATE — checkOne, checkMany, classifier, default transport
routes/api.js                      # MODIFY — POST /proxies/check, GET /proxies/health
server.js                          # MODIFY — instantiate healthStore, inject into apiRouter
test/healthStore.test.js           # CREATE — 5 unit tests
test/proxyHealth.test.js           # CREATE — 7 unit tests (faked transport)
test/api.proxies.health.test.js    # CREATE — 6 supertest tests

frontend/src/lib/api.ts            # MODIFY — ProxyHealthEntry, ProxyHealthResponse types
frontend/src/lib/error-labels.ts   # MODIFY — drop "(15 сек)" from `timeout` label
frontend/src/lib/proxyKey.ts       # CREATE — shared keyOf() helper
frontend/src/pages/ProxiesPage.tsx # MODIFY — Status column, Check all, per-row check, useProxyHealth hook
frontend/src/pages/MainPage.tsx    # MODIFY — preflight confirm before POST /api/send

docs/next-steps.md                 # MODIFY — append smoke-test step for /proxies health
```

Each file has one responsibility. `healthStore` only manages the map. `proxyHealth` only runs probes. `routes/api.js` only exposes endpoints. UI pieces follow the existing `ProxiesPage` / `MainPage` split.

---

## Task 1: Add `socks` direct dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Read current `package.json` dependencies block**

Run: `node -e "console.log(Object.keys(require('./package.json').dependencies).sort().join('\n'))"`
Expected: list of deps including `socks-proxy-agent` but NOT `socks`.

- [ ] **Step 2: Install `socks` as a direct dependency**

Run: `npm install socks@^2.7.0 --save-exact=false`
Expected: `package.json` gets `"socks": "^2.x.x"` in `dependencies`. `package-lock.json` updates. No other dep moves.

- [ ] **Step 3: Verify installation**

Run: `node -e "const { SocksClient } = require('socks'); console.log(typeof SocksClient.createConnection)"`
Expected: `function`

- [ ] **Step 4: Verify tests still pass**

Run: `npm test`
Expected: all existing tests green (no behavior change).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add socks as direct dependency (for proxy health probe)"
```

---

## Task 2: `healthStore.js` — in-memory map factory

**Files:**
- Create: `healthStore.js`
- Create: `test/healthStore.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/healthStore.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthStore, keyOf } from '../healthStore.js';

test('keyOf: composes host:port|user|pass; missing creds become empty', () => {
  assert.equal(keyOf({ host: '1.2.3.4', port: 1080 }), '1.2.3.4:1080||');
  assert.equal(keyOf({ host: 'h', port: 80, username: 'u', password: 'p' }), 'h:80|u|p');
  assert.equal(keyOf({ host: 'h', port: 80, username: 'u' }), 'h:80|u|');
});

test('createHealthStore: set then get returns entry; missing key returns null', () => {
  const s = createHealthStore();
  s.set('k1', { ok: true, latencyMs: 100, checkedAt: 1000 });
  assert.deepEqual(s.get('k1'), { ok: true, latencyMs: 100, checkedAt: 1000 });
  assert.equal(s.get('missing'), null);
});

test('getEntriesFor: preserves input order, null for absent proxies', () => {
  const s = createHealthStore();
  const p1 = { host: 'a', port: 1, username: '', password: '' };
  const p2 = { host: 'b', port: 2, username: '', password: '' };
  s.set(keyOf(p1), { ok: true, latencyMs: 50, checkedAt: 1 });
  const r = s.getEntriesFor([p1, p2]);
  assert.equal(r.length, 2);
  assert.equal(r[0].key, 'a:1||');
  assert.deepEqual(r[0].entry, { ok: true, latencyMs: 50, checkedAt: 1 });
  assert.equal(r[1].entry, null);
});

test('getDeadCount: counts only entries with ok === false', () => {
  const s = createHealthStore();
  const p1 = { host: 'a', port: 1 };
  const p2 = { host: 'b', port: 2 };
  const p3 = { host: 'c', port: 3 };
  s.set(keyOf(p1), { ok: true, latencyMs: 10, checkedAt: 1 });
  s.set(keyOf(p2), { ok: false, error: 'proxy_unreachable', latencyMs: 5000, checkedAt: 2 });
  // p3: no entry → unknown, NOT counted as dead
  assert.equal(s.getDeadCount([p1, p2, p3]), 1);
});

test('getAll: returns array of { key, ...entry }', () => {
  const s = createHealthStore();
  s.set('k1', { ok: true, latencyMs: 10, checkedAt: 1 });
  s.set('k2', { ok: false, error: 'timeout', latencyMs: 5000, checkedAt: 2 });
  const all = s.getAll();
  assert.equal(all.length, 2);
  const k1 = all.find(e => e.key === 'k1');
  assert.deepEqual(k1, { key: 'k1', ok: true, latencyMs: 10, checkedAt: 1 });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/healthStore.test.js`
Expected: `Cannot find module '../healthStore.js'` (5 tests fail).

- [ ] **Step 3: Implement `healthStore.js`**

Create `healthStore.js`:

```js
export const keyOf = (p) =>
  `${p.host}:${p.port}|${p.username ?? ''}|${p.password ?? ''}`;

export function createHealthStore() {
  const map = new Map();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, entry) => { map.set(key, entry); },
    getAll: () => Array.from(map.entries()).map(([key, entry]) => ({ key, ...entry })),
    getEntriesFor: (proxies) =>
      proxies.map(p => ({ key: keyOf(p), entry: map.get(keyOf(p)) ?? null })),
    getDeadCount: (proxies) =>
      proxies.filter(p => map.get(keyOf(p))?.ok === false).length
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test test/healthStore.test.js`
Expected: 5 tests pass.

- [ ] **Step 5: Run full suite to ensure no regressions**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add healthStore.js test/healthStore.test.js
git commit -m "feat(health): in-memory health store for proxy status"
```

---

## Task 3: `proxyHealth.js` — `checkOne` + `checkMany` + classifier (faked transport)

**Files:**
- Create: `proxyHealth.js`
- Create: `test/proxyHealth.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/proxyHealth.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOne, checkMany } from '../proxyHealth.js';

// Fake transport: tests inject their own connect() behavior.
function fakeTransport(behavior) {
  return { connect: behavior };
}

// Reusable fake socket with a spied destroy().
function fakeSocket() {
  const s = { destroyed: false, destroy() { this.destroyed = true; } };
  return s;
}

const PROXY = { host: '1.2.3.4', port: 1080 };

test('checkOne: ok path returns { ok: true, latencyMs } and destroys socket', async () => {
  const sock = fakeSocket();
  const transport = fakeTransport(async () => sock);
  const r = await checkOne(PROXY, { transport, timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(typeof r.latencyMs, 'number');
  assert.ok(r.latencyMs >= 0);
  assert.equal(sock.destroyed, true);
});

test('checkOne: timeout when transport never resolves', async () => {
  const transport = fakeTransport(() => new Promise(() => {}));   // never resolves
  const r = await checkOne(PROXY, { transport, timeoutMs: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
  assert.ok(r.latencyMs >= 30);
});

test('checkOne: ECONNREFUSED classifies as proxy_unreachable', async () => {
  const transport = fakeTransport(async () => {
    const e = new Error('connect ECONNREFUSED');
    e.code = 'ECONNREFUSED';
    throw e;
  });
  const r = await checkOne(PROXY, { transport, timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'proxy_unreachable');
  assert.match(r.details, /ECONNREFUSED/);
});

test('checkOne: SOCKS auth error classifies as proxy_auth_failed', async () => {
  const transport = fakeTransport(async () => {
    throw new Error('Socks5 Authentication failed.');
  });
  const r = await checkOne(PROXY, { transport, timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'proxy_auth_failed');
});

test('checkOne: SOCKS host-unreachable reply classifies as twitch_unreachable', async () => {
  const transport = fakeTransport(async () => {
    throw new Error('Socks5 proxy rejected connection: Host unreachable');
  });
  const r = await checkOne(PROXY, { transport, timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'twitch_unreachable');
});

test('checkOne: unknown error falls back to unknown class with details', async () => {
  const transport = fakeTransport(async () => { throw new Error('something weird'); });
  const r = await checkOne(PROXY, { transport, timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unknown');
  assert.match(r.details, /something weird/);
});

test('checkMany: preserves input order; runs concurrently', async () => {
  let inflight = 0, maxInflight = 0;
  const transport = fakeTransport(async () => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise(r => setTimeout(r, 20));
    inflight--;
    return fakeSocket();
  });
  const proxies = [
    { host: 'a', port: 1 },
    { host: 'b', port: 2 },
    { host: 'c', port: 3 }
  ];
  const r = await checkMany(proxies, { transport, timeoutMs: 1000, concurrency: 3 });
  assert.equal(r.length, 3);
  assert.ok(r.every(x => x.ok === true));
  assert.equal(maxInflight, 3);   // all three were in flight at once
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/proxyHealth.test.js`
Expected: `Cannot find module '../proxyHealth.js'` (7 tests fail).

- [ ] **Step 3: Implement `proxyHealth.js` (without real-network transport yet)**

Create `proxyHealth.js`:

```js
import pLimit from 'p-limit';

const AUTH_FAIL_MARKERS = [
  'authentication failed',
  'authentication required'
];

const TWITCH_UNREACHABLE_MARKERS = [
  'host unreachable',
  'network unreachable',
  'connection not allowed',
  'connection refused by destination'
];

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'ENETUNREACH'
]);

export function classify(err) {
  if (!err) return 'unknown';
  const code = err.code;
  const msg = String(err.message || '').toLowerCase();
  if (UNREACHABLE_CODES.has(code)) return 'proxy_unreachable';
  if (AUTH_FAIL_MARKERS.some(m => msg.includes(m))) return 'proxy_auth_failed';
  if (TWITCH_UNREACHABLE_MARKERS.some(m => msg.includes(m))) return 'twitch_unreachable';
  return 'unknown';
}

export async function checkOne(proxy, opts = {}) {
  const transport = opts.transport;
  if (!transport) throw new Error('checkOne: opts.transport is required');
  const timeoutMs = opts.timeoutMs ?? 5000;
  const destination = opts.destination ?? { host: 'irc-ws.chat.twitch.tv', port: 443 };
  const start = Date.now();

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('timeout');
      e.code = 'CHECK_TIMEOUT';
      reject(e);
    }, timeoutMs);
  });

  try {
    const socket = await Promise.race([
      transport.connect({ proxy, destination, timeoutMs }),
      timeoutPromise
    ]);
    clearTimeout(timer);
    try { socket?.destroy?.(); } catch {}
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    clearTimeout(timer);
    const error = err?.code === 'CHECK_TIMEOUT' ? 'timeout' : classify(err);
    return { ok: false, error, details: err?.message ?? String(err), latencyMs: Date.now() - start };
  }
}

export async function checkMany(proxies, opts = {}) {
  const limit = pLimit(opts.concurrency ?? 8);
  return Promise.all(proxies.map(p => limit(() => checkOne(p, opts))));
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test test/proxyHealth.test.js`
Expected: 7 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add proxyHealth.js test/proxyHealth.test.js
git commit -m "feat(health): checkOne/checkMany probes with error classifier"
```

---

## Task 4: Default SOCKS transport wiring

**Files:**
- Modify: `proxyHealth.js`

No test changes — real-network behavior is out of test scope (matches `twitch.js` style: production transport is wired but not tested with real connections).

- [ ] **Step 1: Add `defaultSocksTransport` to `proxyHealth.js`**

Edit `proxyHealth.js`. Add this import near the top alongside `pLimit`:

```js
import { SocksClient } from 'socks';
```

Add this export above `checkOne`:

```js
export const defaultSocksTransport = {
  async connect({ proxy, destination }) {
    const socksOpts = {
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        ...(proxy.username ? { userId: proxy.username } : {}),
        ...(proxy.password ? { password: proxy.password } : {})
      },
      destination: { host: destination.host, port: destination.port },
      command: 'connect'
    };
    const { socket } = await SocksClient.createConnection(socksOpts);
    return socket;
  }
};
```

Change `checkOne`'s transport line:

```js
const transport = opts.transport ?? defaultSocksTransport;
if (!transport) throw new Error('checkOne: opts.transport is required');
```

becomes:

```js
const transport = opts.transport ?? defaultSocksTransport;
```

(Drop the explicit check — the default is always present.)

- [ ] **Step 2: Update existing tests to keep injecting their fake transport**

The test in Task 3 already passes `opts.transport` explicitly, so nothing should break. Verify:

Run: `node --test test/proxyHealth.test.js`
Expected: 7 tests pass.

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add proxyHealth.js
git commit -m "feat(health): default SOCKS5 transport using socks package"
```

---

## Task 5: API endpoints — `POST /api/proxies/check` + `GET /api/proxies/health`

**Files:**
- Modify: `routes/api.js`
- Create: `test/api.proxies.health.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/api.proxies.health.test.js`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../store.js';
import { createSender } from '../sender.js';
import { createHealthStore } from '../healthStore.js';
import { apiRouter } from '../routes/api.js';

function buildApp({ store, healthStore, checkOne }) {
  const sender = createSender({ sendOne: async () => ({ ok: true, durationMs: 1 }) });
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ store, sender, healthStore, checkOne }));
  return app;
}

const VALID_PROXIES = [
  { host: '1.1.1.1', port: 1080 },
  { host: '2.2.2.2', port: 1080, username: 'u', password: 'p' },
  { host: '3.3.3.3', port: 1080 }
];

let dir, store, healthStore;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'apihealth-'));
  store = new Store(dir);
  healthStore = createHealthStore();
  await store.write('proxies', VALID_PROXIES);
});

test('POST /api/proxies/check without body: checks all proxies', async () => {
  const calls = [];
  const fakeCheck = async (proxy) => { calls.push(proxy.host); return { ok: true, latencyMs: 10 }; };
  const app = buildApp({ store, healthStore, checkOne: fakeCheck });
  const r = await request(app).post('/api/proxies/check').send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 3);
  assert.deepEqual(calls.sort(), ['1.1.1.1', '2.2.2.2', '3.3.3.3']);
  assert.ok(r.body.results.every(x => x.ok === true));
  assert.ok(r.body.results.every(x => typeof x.checkedAt === 'number'));
  // store side effect
  assert.equal(healthStore.getAll().length, 3);
});

test('POST /api/proxies/check with indices: checks only selected', async () => {
  const calls = [];
  const fakeCheck = async (proxy) => { calls.push(proxy.host); return { ok: true, latencyMs: 10 }; };
  const app = buildApp({ store, healthStore, checkOne: fakeCheck });
  const r = await request(app).post('/api/proxies/check').send({ indices: [0, 2] });
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 2);
  assert.deepEqual(calls.sort(), ['1.1.1.1', '3.3.3.3']);
  assert.equal(r.body.results[0].index, 0);
  assert.equal(r.body.results[1].index, 2);
});

test('POST /api/proxies/check: rejects out-of-range and non-integer indices with 400', async () => {
  const app = buildApp({ store, healthStore, checkOne: async () => ({ ok: true, latencyMs: 1 }) });
  const r1 = await request(app).post('/api/proxies/check').send({ indices: [99] });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error, 'invalid_indices');
  const r2 = await request(app).post('/api/proxies/check').send({ indices: [1.5] });
  assert.equal(r2.status, 400);
  const r3 = await request(app).post('/api/proxies/check').send({ indices: 'nope' });
  assert.equal(r3.status, 400);
});

test('POST /api/proxies/check: 409 when another check is in flight', async () => {
  let release;
  const blocker = new Promise(r => { release = r; });
  const slowCheck = async () => { await blocker; return { ok: true, latencyMs: 1 }; };
  const app = buildApp({ store, healthStore, checkOne: slowCheck });
  const firstPromise = request(app).post('/api/proxies/check').send({});
  // small tick so the lock is acquired
  await new Promise(r => setTimeout(r, 10));
  const second = await request(app).post('/api/proxies/check').send({});
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'check_running');
  release();
  const first = await firstPromise;
  assert.equal(first.status, 200);
});

test('POST /api/proxies/check: failed result writes ok:false into store with error/details', async () => {
  const fakeCheck = async (proxy) => {
    if (proxy.host === '2.2.2.2') {
      return { ok: false, error: 'proxy_auth_failed', details: 'bad creds', latencyMs: 50 };
    }
    return { ok: true, latencyMs: 10 };
  };
  const app = buildApp({ store, healthStore, checkOne: fakeCheck });
  const r = await request(app).post('/api/proxies/check').send({});
  assert.equal(r.status, 200);
  const dead = r.body.results.find(x => !x.ok);
  assert.equal(dead.error, 'proxy_auth_failed');
  assert.equal(dead.details, 'bad creds');
  // The store has the dead entry under the right key
  const entry = healthStore.get('2.2.2.2:1080|u|p');
  assert.equal(entry?.ok, false);
  assert.equal(entry?.error, 'proxy_auth_failed');
});

test('GET /api/proxies/health returns dump of all entries', async () => {
  healthStore.set('1.1.1.1:1080||', { ok: true, latencyMs: 10, checkedAt: 100 });
  healthStore.set('2.2.2.2:1080|u|p', { ok: false, error: 'timeout', latencyMs: 5000, checkedAt: 200 });
  const app = buildApp({ store, healthStore, checkOne: async () => ({ ok: true, latencyMs: 1 }) });
  const r = await request(app).get('/api/proxies/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.entries.length, 2);
  const live = r.body.entries.find(e => e.key === '1.1.1.1:1080||');
  assert.equal(live.ok, true);
  assert.equal(live.latencyMs, 10);
  assert.equal(live.checkedAt, 100);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/api.proxies.health.test.js`
Expected: 6 tests fail (router doesn't expose `/proxies/check` or `/proxies/health` yet).

- [ ] **Step 3: Modify `routes/api.js` to accept `healthStore` + `checkOne`, add endpoints**

Edit `routes/api.js`. Add at the top of the file (next to existing imports):

```js
import { checkOne as defaultCheckOne } from '../proxyHealth.js';
import { keyOf } from '../healthStore.js';
```

Change the `apiRouter` signature from:

```js
export function apiRouter({ store, sender, sendOne: sendOneImpl }) {
```

to:

```js
export function apiRouter({ store, sender, sendOne: sendOneImpl, healthStore, checkOne: checkOneImpl }) {
```

After the `crud(...)` calls (and before `r.post('/quick-send', ...)`), add the lock state and the two endpoints:

```js
  const checkOneFn = checkOneImpl ?? defaultCheckOne;
  let checkInFlight = false;

  r.post('/proxies/check', async (req, res) => {
    if (!healthStore) return res.status(500).json({ error: 'no_health_store' });
    if (checkInFlight) return res.status(409).json({ error: 'check_running' });

    const proxies = await store.read('proxies');
    const body = req.body || {};
    let indices;
    if (body.indices === undefined) {
      indices = proxies.map((_, i) => i);
    } else {
      if (!Array.isArray(body.indices)) return res.status(400).json({ error: 'invalid_indices' });
      const valid = body.indices.every(i =>
        Number.isInteger(i) && i >= 0 && i < proxies.length
      );
      if (!valid) return res.status(400).json({ error: 'invalid_indices' });
      indices = body.indices;
    }

    checkInFlight = true;
    try {
      const results = await Promise.all(indices.map(async (i) => {
        const proxy = proxies[i];
        const r = await checkOneFn(proxy);
        const key = keyOf(proxy);
        const entry = {
          ok: r.ok,
          latencyMs: r.latencyMs,
          checkedAt: Date.now(),
          ...(r.error ? { error: r.error } : {}),
          ...(r.details ? { details: r.details } : {})
        };
        healthStore.set(key, entry);
        return { index: i, key, ...entry };
      }));
      res.json({ results });
    } finally {
      checkInFlight = false;
    }
  });

  r.get('/proxies/health', (_req, res) => {
    if (!healthStore) return res.status(500).json({ error: 'no_health_store' });
    res.json({ entries: healthStore.getAll() });
  });
```

- [ ] **Step 4: Run new tests, verify they pass**

Run: `node --test test/api.proxies.health.test.js`
Expected: 6 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all green. (Existing `api.test.js` calls `apiRouter({ store, sender })` without health-store — that still works because both new args are optional.)

- [ ] **Step 6: Commit**

```bash
git add routes/api.js test/api.proxies.health.test.js
git commit -m "feat(health): POST /api/proxies/check + GET /api/proxies/health"
```

---

## Task 6: Wire `healthStore` into `server.js`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Edit `server.js` to instantiate and inject**

In `server.js`, find the imports near the top:

```js
import { createSender } from './sender.js';
import { sendOne } from './twitch.js';
```

Add directly below:

```js
import { createHealthStore } from './healthStore.js';
```

Find the line that creates `sender`:

```js
const sender = createSender({ sendOne });
```

Add right below:

```js
const healthStore = createHealthStore();
```

Find the apiRouter mount:

```js
app.use('/api', requireAuth, csrf, apiRouter({ store, sender }));
```

Change to:

```js
app.use('/api', requireAuth, csrf, apiRouter({ store, sender, healthStore }));
```

- [ ] **Step 2: Verify server starts**

Run: `node -e "import('./server.js').catch(e => { console.error(e); process.exit(1); })" 2>&1 | head -n 3`

Or, easier — just start it briefly:

Run (PowerShell): `$p = Start-Process -PassThru node server.js -RedirectStandardOutput out.log; Start-Sleep -Seconds 1; Stop-Process $p; Get-Content out.log; Remove-Item out.log`
Expected: log line `listening http://127.0.0.1:3000` before kill.

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(health): wire healthStore into server"
```

---

## Task 7: `error-labels.ts` — drop hardcoded "(15 сек)" from `timeout`

**Files:**
- Modify: `frontend/src/lib/error-labels.ts`

- [ ] **Step 1: Edit the label**

In `frontend/src/lib/error-labels.ts`, change:

```ts
  timeout: 'Превышено время ожидания (15 сек)',
```

to:

```ts
  timeout: 'Превышено время ожидания',
```

- [ ] **Step 2: Verify build still works (TypeScript happy)**

Run: `npm run build`
Expected: `vite build` succeeds, `dist/` updated. No type errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/error-labels.ts
git commit -m "fix(spa): make 'timeout' label generic (sendOne is 15s, health-check is 5s)"
```

---

## Task 8: `api.ts` — add health types

**Files:**
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Append health types to `api.ts`**

In `frontend/src/lib/api.ts`, after the `QuickSendResponse` type (around line 32, before the `request` function), add:

```ts
export type ProxyHealthEntry = {
  key: string;
  ok: boolean;
  latencyMs: number;
  checkedAt: number;
  error?: string;
  details?: string;
};

export type ProxyHealthResponse = { entries: ProxyHealthEntry[] };

export type ProxyCheckResult = ProxyHealthEntry & { index: number };
export type ProxyCheckResponse = { results: ProxyCheckResult[] };
```

- [ ] **Step 2: Verify TypeScript build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat(spa): ProxyHealthEntry / ProxyCheckResponse types"
```

---

## Task 9: `proxyKey.ts` — shared `keyOf` helper

**Files:**
- Create: `frontend/src/lib/proxyKey.ts`

- [ ] **Step 1: Create the helper**

Create `frontend/src/lib/proxyKey.ts`:

```ts
import type { Proxy } from './api';

export const keyOf = (p: Pick<Proxy, 'host' | 'port' | 'username' | 'password'>): string =>
  `${p.host}:${p.port}|${p.username ?? ''}|${p.password ?? ''}`;
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: success (no consumers yet, just must compile).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/proxyKey.ts
git commit -m "feat(spa): keyOf helper shared between Proxies and Main pages"
```

---

## Task 10: `ProxiesPage.tsx` — Status column + Check all + per-row check

**Files:**
- Modify: `frontend/src/pages/ProxiesPage.tsx`

This task is UI; tests stay manual (consistent with the existing SPA, which has no frontend tests).

- [ ] **Step 1: Add `relativeTime` helper file (small, local to ProxiesPage)**

Inside `frontend/src/pages/ProxiesPage.tsx`, just below the imports, add:

```ts
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return 'только что';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} сек назад`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`;
  return `${Math.floor(diff / 86_400_000)} дн назад`;
}
```

- [ ] **Step 2: Add imports for new types/icon/Badge/keyOf**

At the top of `ProxiesPage.tsx`, modify the existing imports:

```ts
import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { api, type Proxy, type ProxyHealthEntry, type ProxyHealthResponse, type ProxyCheckResponse } from '@/lib/api';
import { errLabel } from '@/lib/error-labels';
import { keyOf } from '@/lib/proxyKey';
import { Trash2, Activity } from 'lucide-react';
```

- [ ] **Step 3: Add `useProxyHealth` hook inside the file**

Inside `ProxiesPage.tsx`, above `export default function ProxiesPage()`, add:

```ts
function useProxyHealth() {
  const [byKey, setByKey] = useState<Record<string, ProxyHealthEntry>>({});
  const refresh = useCallback(async () => {
    const r = await api.get<ProxyHealthResponse>('/api/proxies/health');
    if (r) setByKey(Object.fromEntries(r.entries.map(e => [e.key, e])));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { byKey, refresh };
}
```

- [ ] **Step 4: Use the hook + add `checking` state inside the component**

Inside `export default function ProxiesPage()`, after `const [bulk, setBulk] = useState('');`, add:

```ts
const { byKey: health, refresh: refreshHealth } = useProxyHealth();
const [checking, setChecking] = useState(false);

const runCheck = async (indices?: number[]) => {
  if (checking) return;
  setChecking(true);
  try {
    const res = await api.request<ProxyCheckResponse>('POST', '/api/proxies/check', indices ? { indices } : {});
    if (res.ok) {
      const ok = res.data.results.filter(r => r.ok).length;
      const failed = res.data.results.length - ok;
      toast.success(`Проверено: ${ok} ok, ${failed} fail`);
      await refreshHealth();
    } else if (res.err.status === 409) {
      toast.error('Проверка уже идёт');
    } else {
      toast.error(errLabel(res.err.error) || `HTTP ${res.err.status}`);
    }
  } finally {
    setChecking(false);
  }
};
```

- [ ] **Step 5: Add the Status column to the `<TableHeader>`**

Inside the `<TableHeader><TableRow>...</TableRow></TableHeader>` block, between the existing `<TableHead>Pass</TableHead>` and the trailing `<TableHead className="w-[60px]"></TableHead>`, insert:

```tsx
<TableHead className="w-[200px]">Status</TableHead>
```

- [ ] **Step 6: Add the Status cell + per-row Check button**

Inside each `<TableRow key={i}>` block, between the password `<TableCell>` and the `<TableCell><Button size="icon"...><Trash2/>...</Button></TableCell>`, insert:

```tsx
<TableCell>
  {(() => {
    const key = keyOf({
      host: r.host.trim(),
      port: Number(r.port),
      username: r.username.trim() || undefined,
      password: r.password || undefined
    });
    const entry = health[key];
    if (!entry) return <span className="text-muted-foreground">—</span>;
    return (
      <div className="space-y-0.5">
        {entry.ok
          ? <Badge variant="default">✓ {entry.latencyMs}ms</Badge>
          : <Badge variant="destructive">× {errLabel(entry.error) || entry.error}</Badge>}
        <div className="text-xs text-muted-foreground">checked {relativeTime(entry.checkedAt)}</div>
      </div>
    );
  })()}
</TableCell>
```

And modify the existing trash-cell to add a sibling Check button — change:

```tsx
<TableCell><Button size="icon" variant="ghost" onClick={() => removeRow(i)}><Trash2 className="h-4 w-4" /></Button></TableCell>
```

to:

```tsx
<TableCell>
  <div className="flex gap-1">
    <Button size="icon" variant="ghost" onClick={() => runCheck([i])} disabled={checking} title="Check">
      <Activity className="h-4 w-4" />
    </Button>
    <Button size="icon" variant="ghost" onClick={() => removeRow(i)} title="Delete">
      <Trash2 className="h-4 w-4" />
    </Button>
  </div>
</TableCell>
```

Also widen that header cell to fit two icons — change:

```tsx
<TableHead className="w-[60px]"></TableHead>
```

to:

```tsx
<TableHead className="w-[100px]"></TableHead>
```

And update the empty-state colSpan from 5 to 6:

```tsx
{rows.length === 0 && (
  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">пусто</TableCell></TableRow>
)}
```

- [ ] **Step 7: Add the "Check all" button to the toolbar row**

Change the existing toolbar:

```tsx
<div className="flex gap-2">
  <Button onClick={addRow} variant="outline">+ Row</Button>
  <Button onClick={save}>Save</Button>
</div>
```

to:

```tsx
<div className="flex gap-2">
  <Button onClick={addRow} variant="outline">+ Row</Button>
  <Button onClick={save}>Save</Button>
  <Button onClick={() => runCheck()} variant="secondary" disabled={checking}>
    {checking ? 'Проверка…' : 'Check all'}
  </Button>
</div>
```

- [ ] **Step 8: Verify TypeScript build**

Run: `npm run build`
Expected: success.

- [ ] **Step 9: Manual smoke test**

Run: `npm start` (in one terminal), open http://127.0.0.1:3000, log in.
- Add a proxy that should be reachable (or any host:port — the check will mark it dead).
- Save.
- Click "Check all" — observe Status column updates within ~5s.
- For a definitely-dead proxy (e.g. `127.0.0.1:1` — refused), confirm badge shows `× ...` with appropriate error label.
- Click the per-row Activity icon on one row — only that row should update its `checkedAt`.

Verification ≠ guarantee: if you can't run a real proxy locally, at minimum confirm the toast "Проверено: 0 ok, N fail" appears and the table re-renders.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/pages/ProxiesPage.tsx
git commit -m "feat(spa): proxy health status column + check buttons on /proxies"
```

---

## Task 11: `MainPage.tsx` — preflight confirm before `/send`

**Files:**
- Modify: `frontend/src/pages/MainPage.tsx`

Integration point: the Send button at line 163 currently reads:

```tsx
<Button onClick={() => startJob('/api/send')} disabled={isRunning}>Send</Button>
```

`startJob` (defined at line 122) is already async and POSTs to the endpoint. `proxies` is already in component state via `reload()` (line 65, 80). So preflight only needs to fetch `/api/proxies/health` on click and consult the existing `proxies` state.

- [ ] **Step 1: Extend imports**

In `MainPage.tsx` line 10:

```ts
import { api, type Account, type Proxy, type Settings, type JobEvent } from '@/lib/api';
```

Change to:

```ts
import { api, type Account, type Proxy, type Settings, type JobEvent, type ProxyHealthResponse } from '@/lib/api';
```

And add a new import line just below:

```ts
import { keyOf } from '@/lib/proxyKey';
```

- [ ] **Step 2: Add a `confirmDeadProxies` helper inside the component**

Inside `export default function MainPage()`, just above the `async function startJob(...)` declaration (around line 122), add:

```tsx
async function confirmDeadProxies(): Promise<boolean> {
  if (proxies.length === 0) return true;
  const health = await api.get<ProxyHealthResponse>('/api/proxies/health');
  const byKey = Object.fromEntries((health?.entries ?? []).map(e => [e.key, e]));
  const dead = proxies.filter(p => byKey[keyOf(p)]?.ok === false).length;
  if (dead === 0) return true;
  return window.confirm(`${dead} прокси помечены как мёртвые — аккаунты на них могут упасть. Продолжить?`);
}
```

- [ ] **Step 3: Wire it into the Send button onClick**

Find (line 163):

```tsx
<Button onClick={() => startJob('/api/send')} disabled={isRunning}>Send</Button>
```

Change to:

```tsx
<Button
  onClick={async () => {
    if (await confirmDeadProxies()) startJob('/api/send');
  }}
  disabled={isRunning}
>
  Send
</Button>
```

Do NOT wrap the `Retry failed` button (line 165) — the user already accepted the warning when starting the original job; warning twice is friction.

- [ ] **Step 4: Verify TypeScript build**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Manual smoke test**

Run: `npm start`, log in.
- On `/proxies`, add at least one proxy. Click "Check all". At least one should be marked dead (badge red). Optionally add a proxy that should pass.
- Go back to `/`.
- If any proxies are marked dead: clicking Send shows `confirm("N прокси помечены как мёртвые…")`. Cancel → no send (no events appear). OK → send proceeds normally.
- If all proxies are healthy (or no proxies, or no health entries yet): clicking Send goes straight to send (no dialog).
- "Retry failed" (if it appears) should NOT trigger a confirm.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/MainPage.tsx
git commit -m "feat(spa): preflight confirm on Send when proxies are marked dead"
```

---

## Task 12: Update `docs/next-steps.md`

**Files:**
- Modify: `docs/next-steps.md`

- [ ] **Step 1: Append a new section after Step 3**

Open `docs/next-steps.md`. After the section "Шаг 3. Полный sanity-check на 5 аккаунтах" (around line 77), insert a new section:

```markdown
---

## Шаг 3.5. Health-check прокси (новая фича)

Цель: убедиться, что кнопка проверки и pre-send confirm работают.

1. На `/proxies` добавь хотя бы один заведомо мёртвый прокси (например `127.0.0.1:1`) и один рабочий.
2. Нажми **Check all**.
3. **Ожидаемо:** через ~1–5 сек у живого — зелёный бэйдж `✓ Nms`, у мёртвого — красный `× <текст>`. Под бэйджем — относительное время.
4. Кликни **Activity-иконку** в строке живого прокси — обновится только её `checkedAt`.
5. Перейди на `/`, нажми **Send** — должно появиться `confirm("N прокси помечены как мёртвые…")`. Отмена → ничего не отправляется. ОК → bulk-send идёт как обычно.
6. Если все прокси здоровые — Send идёт без подтверждения.
```

- [ ] **Step 2: Commit**

```bash
git add docs/next-steps.md
git commit -m "docs: add health-check smoke-test step"
```

---

## Final Verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all green, +18 tests vs. baseline.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean `dist/` build.

- [ ] **Step 3: Boot the server**

Run: `npm start`
Visit http://127.0.0.1:3000, log in, exercise the new flow end-to-end (Tasks 10 / 11 / 12 smoke steps).

- [ ] **Step 4: Confirm scope**

Skim the spec sections 2 (functional reqs) and 12 (out-of-scope). Verify:
- Status column ✓, Check all ✓, per-row check ✓, `409 check_running` toast ✓, `window.confirm` preflight ✓, no QuickSend changes ✓, no `/send` server-side gating ✓, in-memory only (no `proxies.json` schema change) ✓.
- Did NOT add: background recheck, persistence, auto-skip, per-account preflight, AbortController. ✓
