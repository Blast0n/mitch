# Follows Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/follows` page that lists each account's followed channels and lets the user follow a streamer with any subset of their accounts, routed through the same SOCKS5 proxies as chat.

**Architecture:** New `twitchGql.js` (low-level GQL client mirroring `twitch.js`) + `follows.js` (service factory with in-memory cache and two independent locks, mirroring `sender.js`). Four new API endpoints expose list/refresh/follow. Frontend gets a new page with a follow form on top and a per-account follows table below. Uses Twitch's private GQL endpoint with the integrated web client-id (`kimne78kx3ncx6brgo4mv6wki5h1ko`); existing `chat:edit` OAuth tokens work, no new scopes.

**Tech Stack:** Existing — Express, `node:test`, `supertest`, React+Vite, shadcn/lucide-react. No new dependencies (`socks-proxy-agent` already present; GQL via built-in `node:https`).

**Spec:** [`docs/superpowers/specs/2026-05-28-follows-management-design.md`](../specs/2026-05-28-follows-management-design.md)

---

## File Structure

```
twitchGql.js                                # CREATE — GQL client primitives + classifier + default https/SOCKS transport
follows.js                                  # CREATE — service factory (cache + locks + listFollows/refreshAll/followStreamer/getCacheMetadata)
routes/api.js                               # MODIFY — 4 endpoints + accept followsService DI
server.js                                   # MODIFY — instantiate followsService, inject into apiRouter
test/twitchGql.test.js                      # CREATE — ~13 unit tests with faked transport
test/follows.test.js                        # CREATE — ~17 unit tests with faked twitchGql
test/api.follows.test.js                    # CREATE — ~16 supertest tests

frontend/src/lib/time.ts                    # CREATE — relativeTime helper (extracted from ProxiesPage)
frontend/src/lib/api.ts                     # MODIFY — Follow / FollowsCache* / Refresh / FollowAction types
frontend/src/lib/error-labels.ts            # MODIFY — add 8 new error labels
frontend/src/pages/ProxiesPage.tsx          # MODIFY — switch to imported relativeTime, drop inline copy
frontend/src/pages/FollowsPage.tsx          # CREATE — page with follow form + accounts table
frontend/src/App.tsx                        # MODIFY — add /follows Route
frontend/src/components/Nav.tsx             # MODIFY — add Follows nav link

docs/next-steps.md                          # MODIFY — append Шаг 3.6 smoke-test step
```

Each file has one responsibility. `twitchGql.js` only does GQL transport + classification. `follows.js` only does cache + orchestration. UI splits into focused components / page.

---

## Task 1: `twitchGql.js` — classifier + 3 operations (with fake transport, TDD)

**Files:**
- Create: `twitchGql.js`
- Create: `test/twitchGql.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/twitchGql.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUserId, getFollowedChannels, followUser, classifyGqlError } from '../twitchGql.js';

// Fake transport — tests inject ({ query, variables, token, proxy }) => { status, body } | throws
function fake(behavior) { return { send: behavior }; }

const PROXY = { host: '1.2.3.4', port: 1080 };
const TOKEN = 'oauth:abc123';

// ===== classifyGqlError =====

test('classifyGqlError: ECONNREFUSED → proxy_unreachable', () => {
  const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED';
  assert.equal(classifyGqlError(e), 'proxy_unreachable');
});

test('classifyGqlError: socks host-unreachable → twitch_unreachable', () => {
  assert.equal(classifyGqlError(new Error('Socks5 proxy rejected connection: Host unreachable')), 'twitch_unreachable');
});

test('classifyGqlError: unknown error → unknown', () => {
  assert.equal(classifyGqlError(new Error('weird stuff')), 'unknown');
});

// ===== resolveUserId =====

test('resolveUserId: 200 with user.id → returns id', async () => {
  let received;
  const transport = fake(async (args) => {
    received = args;
    return { status: 200, body: { data: { user: { id: '12345' } } } };
  });
  const id = await resolveUserId('foo', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000 });
  assert.equal(id, '12345');
  // token must be passed WITHOUT 'oauth:' prefix
  assert.equal(received.token, 'abc123');
  assert.equal(received.proxy, PROXY);
  assert.match(received.query, /UserLookup/);
  assert.deepEqual(received.variables, { login: 'foo' });
});

test('resolveUserId: 200 with data.user === null → streamer_not_found', async () => {
  const transport = fake(async () => ({ status: 200, body: { data: { user: null } } }));
  await assert.rejects(
    () => resolveUserId('nope', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000 }),
    (e) => e.class === 'streamer_not_found'
  );
});

test('resolveUserId: 401 → token_invalid', async () => {
  const transport = fake(async () => ({ status: 401, body: {} }));
  await assert.rejects(
    () => resolveUserId('foo', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000 }),
    (e) => e.class === 'token_invalid'
  );
});

test('resolveUserId: transport throws ECONNREFUSED → proxy_unreachable', async () => {
  const transport = fake(async () => {
    const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED';
    throw e;
  });
  await assert.rejects(
    () => resolveUserId('foo', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000 }),
    (e) => e.class === 'proxy_unreachable'
  );
});

test('resolveUserId: transport never resolves → timeout', async () => {
  const transport = fake(() => new Promise(() => {}));
  await assert.rejects(
    () => resolveUserId('foo', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 30 }),
    (e) => e.class === 'timeout'
  );
});

// ===== getFollowedChannels =====

test('getFollowedChannels: single page → returns flat array', async () => {
  const transport = fake(async () => ({
    status: 200,
    body: { data: { user: { follows: {
      edges: [
        { followedAt: '2024-01-01T00:00:00Z', node: { id: '1', login: 's1', displayName: 'S1' } },
        { followedAt: '2024-02-01T00:00:00Z', node: { id: '2', login: 's2', displayName: 'S2' } }
      ],
      pageInfo: { hasNextPage: false }
    } } } }
  }));
  const r = await getFollowedChannels('555', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000 });
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { userId: '1', login: 's1', displayName: 'S1', followedAt: '2024-01-01T00:00:00Z' });
});

test('getFollowedChannels: paginated → concats pages, passes cursor', async () => {
  const calls = [];
  const transport = fake(async (args) => {
    calls.push(args.variables);
    if (calls.length === 1) {
      return { status: 200, body: { data: { user: { follows: {
        edges: [{ followedAt: 't1', node: { id: '1', login: 'a', displayName: 'A' } }],
        pageInfo: { hasNextPage: true }
      } } } } };
    }
    return { status: 200, body: { data: { user: { follows: {
      edges: [{ followedAt: 't2', node: { id: '2', login: 'b', displayName: 'B' } }],
      pageInfo: { hasNextPage: false }
    } } } } };
  });
  const r = await getFollowedChannels('555', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000 });
  assert.equal(r.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].after ?? null, null);
  assert.ok(calls[1].after, 'second call must pass a cursor');
});

test('getFollowedChannels: respects limit (stops after limit reached)', async () => {
  let pages = 0;
  const transport = fake(async () => {
    pages++;
    return { status: 200, body: { data: { user: { follows: {
      edges: Array.from({ length: 100 }, (_, i) => ({
        followedAt: 't', node: { id: String(pages * 100 + i), login: 'x', displayName: 'X' }
      })),
      pageInfo: { hasNextPage: true }
    } } } } };
  });
  const r = await getFollowedChannels('555', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000, limit: 250 });
  assert.equal(r.length, 250);
  // Should stop at page 3 (100+100+50), NOT continue to page 4
  assert.equal(pages, 3);
});

test('getFollowedChannels: empty edges → []', async () => {
  const transport = fake(async () => ({
    status: 200,
    body: { data: { user: { follows: { edges: [], pageInfo: { hasNextPage: false } } } } }
  }));
  const r = await getFollowedChannels('555', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000 });
  assert.deepEqual(r, []);
});

// ===== followUser =====

test('followUser: success → { ok: true, alreadyFollowing: false }', async () => {
  let received;
  const transport = fake(async (args) => {
    received = args;
    return { status: 200, body: { data: { followUser: { follow: { followedAt: 'now' }, error: null } } } };
  });
  const r = await followUser('999', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000 });
  assert.deepEqual(r, { ok: true, alreadyFollowing: false });
  assert.match(received.query, /FollowUser/);
  assert.equal(received.variables.input.targetID, '999');
  assert.equal(received.variables.input.disableNotifications, true);
});

test('followUser: ALREADY_FOLLOWING → { ok: true, alreadyFollowing: true }', async () => {
  const transport = fake(async () => ({
    status: 200,
    body: { data: { followUser: { follow: null, error: { code: 'ALREADY_FOLLOWING' } } } }
  }));
  const r = await followUser('999', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000 });
  assert.deepEqual(r, { ok: true, alreadyFollowing: true });
});

test('followUser: TARGET_USER_NOT_FOUND → throws streamer_not_found', async () => {
  const transport = fake(async () => ({
    status: 200,
    body: { data: { followUser: { follow: null, error: { code: 'TARGET_USER_NOT_FOUND' } } } }
  }));
  await assert.rejects(
    () => followUser('999', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000 }),
    (e) => e.class === 'streamer_not_found'
  );
});

test('followUser: 429 → rate_limited', async () => {
  const transport = fake(async () => ({ status: 429, body: {} }));
  await assert.rejects(
    () => followUser('999', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000 }),
    (e) => e.class === 'rate_limited'
  );
});

test('followUser: 401 → token_invalid', async () => {
  const transport = fake(async () => ({ status: 401, body: {} }));
  await assert.rejects(
    () => followUser('999', { token: TOKEN, proxy: PROXY, transport, timeoutMs: 1000 }),
    (e) => e.class === 'token_invalid'
  );
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/twitchGql.test.js`
Expected: `Cannot find module '../twitchGql.js'`.

- [ ] **Step 3: Implement `twitchGql.js` (without real-network transport yet)**

Create `twitchGql.js`:

```js
const AUTH_FAIL_MARKERS = ['authentication failed', 'authentication required'];
const TWITCH_UNREACHABLE_MARKERS = [
  'host unreachable', 'network unreachable',
  'connection not allowed', 'connection refused by destination'
];
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'ENETUNREACH'
]);

export function classifyGqlError(err) {
  if (!err) return 'unknown';
  const code = err.code;
  const msg = String(err.message || '').toLowerCase();
  if (UNREACHABLE_CODES.has(code)) return 'proxy_unreachable';
  if (AUTH_FAIL_MARKERS.some(m => msg.includes(m))) return 'proxy_auth_failed';
  if (TWITCH_UNREACHABLE_MARKERS.some(m => msg.includes(m))) return 'twitch_unreachable';
  return 'unknown';
}

export class GqlError extends Error {
  constructor(message, klass, details) {
    super(message);
    this.class = klass;
    if (details) this.details = details;
  }
}

const stripOauth = (t) => String(t || '').replace(/^oauth:/, '');

async function withTimeout(promise, timeoutMs) {
  let timer;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => {
      const e = new GqlError('timeout', 'timeout');
      rej(e);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, t]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendGql({ query, variables, operationName, token, proxy, transport, timeoutMs }) {
  if (!transport) throw new Error('sendGql: opts.transport is required');
  const args = { query, variables, operationName, token: stripOauth(token), proxy };
  try {
    return await withTimeout(transport.send(args), timeoutMs);
  } catch (err) {
    if (err instanceof GqlError) throw err;
    throw new GqlError(err.message || String(err), classifyGqlError(err), err.message);
  }
}

function httpStatusClass(status) {
  if (status === 401) return 'token_invalid';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'twitch_unreachable';
  return null;
}

// ============ Operations ============

const USER_LOOKUP_QUERY = `query UserLookup($login: String!) { user(login: $login) { id } }`;

export async function resolveUserId(login, opts = {}) {
  const { token, proxy, transport, timeoutMs = 10000 } = opts;
  const { status, body } = await sendGql({
    query: USER_LOOKUP_QUERY,
    variables: { login },
    operationName: 'UserLookup',
    token, proxy, transport, timeoutMs
  });
  const cls = httpStatusClass(status);
  if (cls) throw new GqlError(`HTTP ${status}`, cls);
  if (status !== 200) throw new GqlError(`HTTP ${status}`, 'unknown');
  const user = body?.data?.user;
  if (user === null || user === undefined) throw new GqlError('user not found', 'streamer_not_found');
  return String(user.id);
}

const FOLLOWED_QUERY = `query FollowedChannels($id: ID!, $first: Int!, $after: Cursor) {
  user(id: $id) {
    follows(first: $first, after: $after) {
      edges { followedAt, node { id, login, displayName } }
      pageInfo { hasNextPage }
    }
  }
}`;

export async function getFollowedChannels(userId, opts = {}) {
  const { token, proxy, transport, timeoutMs = 10000, limit = 500 } = opts;
  const pageSize = 100;
  const results = [];
  let cursor = null;
  while (results.length < limit) {
    const { status, body } = await sendGql({
      query: FOLLOWED_QUERY,
      variables: { id: userId, first: pageSize, after: cursor },
      operationName: 'FollowedChannels',
      token, proxy, transport, timeoutMs
    });
    const cls = httpStatusClass(status);
    if (cls) throw new GqlError(`HTTP ${status}`, cls);
    if (status !== 200) throw new GqlError(`HTTP ${status}`, 'unknown');
    const follows = body?.data?.user?.follows;
    if (!follows) throw new GqlError('no follows in response', 'unknown');
    for (const edge of follows.edges) {
      results.push({
        userId: String(edge.node.id),
        login: edge.node.login,
        displayName: edge.node.displayName,
        followedAt: edge.followedAt
      });
      if (results.length >= limit) break;
    }
    if (!follows.pageInfo?.hasNextPage) break;
    // Cursor is the followedAt of the last edge — Twitch GQL convention for follows pagination.
    cursor = follows.edges[follows.edges.length - 1]?.followedAt ?? null;
    if (!cursor) break;
  }
  return results;
}

const FOLLOW_MUTATION = `mutation FollowUser($input: FollowUserInput!) {
  followUser(input: $input) {
    follow { followedAt }
    error { code }
  }
}`;

export async function followUser(broadcasterId, opts = {}) {
  const { token, proxy, transport, timeoutMs = 10000 } = opts;
  const { status, body } = await sendGql({
    query: FOLLOW_MUTATION,
    variables: { input: { targetID: String(broadcasterId), disableNotifications: true } },
    operationName: 'FollowUser',
    token, proxy, transport, timeoutMs
  });
  const cls = httpStatusClass(status);
  if (cls) throw new GqlError(`HTTP ${status}`, cls);
  if (status !== 200) throw new GqlError(`HTTP ${status}`, 'unknown');
  const r = body?.data?.followUser;
  if (!r) throw new GqlError('no followUser in response', 'unknown');
  if (r.error) {
    const code = r.error.code;
    if (code === 'ALREADY_FOLLOWING') return { ok: true, alreadyFollowing: true };
    if (code === 'TARGET_USER_NOT_FOUND') throw new GqlError(code, 'streamer_not_found');
    throw new GqlError(code, 'unknown');
  }
  return { ok: true, alreadyFollowing: false };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test test/twitchGql.test.js`
Expected: 16 tests pass.

- [ ] **Step 5: Commit**

```bash
git add twitchGql.js test/twitchGql.test.js
git commit -m "feat(follows): twitchGql client with classifier and 3 operations"
```

---

## Task 2: `twitchGql.js` — default HTTPS+SOCKS transport

**Files:**
- Modify: `twitchGql.js`

No test changes — real-network transport is out of test scope (matches `proxyHealth.js` pattern).

- [ ] **Step 1: Add `defaultGqlTransport` to `twitchGql.js`**

In `twitchGql.js`, add these imports at the top (above the markers constants):

```js
import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
```

Add this exported transport above the operations section:

```js
export const defaultGqlTransport = {
  send({ query, variables, operationName, token, proxy }) {
    let agent;
    if (proxy) {
      const auth = proxy.username
        ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
        : '';
      agent = new SocksProxyAgent(`socks5://${auth}${proxy.host}:${proxy.port}`);
    }
    const payload = JSON.stringify({ query, variables, operationName });
    return new Promise((resolve, reject) => {
      const req = https.request('https://gql.twitch.tv/gql', {
        method: 'POST',
        agent,
        headers: {
          'Authorization': `OAuth ${token}`,
          'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { buf += chunk; });
        res.on('end', () => {
          let body;
          try { body = buf ? JSON.parse(buf) : {}; }
          catch (e) { return reject(new Error('non-json response: ' + buf.slice(0, 200))); }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
};
```

Update `sendGql` to default transport. Current code is:

```js
async function sendGql({ query, variables, operationName, token, proxy, transport, timeoutMs }) {
  if (!transport) throw new Error('sendGql: opts.transport is required');
```

Change to:

```js
async function sendGql({ query, variables, operationName, token, proxy, transport, timeoutMs }) {
  transport = transport ?? defaultGqlTransport;
```

(Drop the explicit check — default is always present.)

- [ ] **Step 2: Verify existing tests still pass**

Run: `node --test test/twitchGql.test.js`
Expected: 16 tests pass (all of them inject `opts.transport` explicitly).

- [ ] **Step 3: Commit**

```bash
git add twitchGql.js
git commit -m "feat(follows): default HTTPS+SOCKS transport for twitchGql"
```

---

## Task 3a: `follows.js` — cache, listFollows, refreshAll, getCacheMetadata

**Files:**
- Create: `follows.js`
- Create: `test/follows.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/follows.test.js`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../store.js';
import { createFollowsService } from '../follows.js';

const ACCOUNTS = [
  { login: 'user1', oauthToken: 'oauth:' + 'a'.repeat(30) },
  { login: 'user2', oauthToken: 'oauth:' + 'b'.repeat(30) },
  { login: 'user3', oauthToken: 'oauth:' + 'c'.repeat(30) }
];
const PROXIES = [
  { host: 'p1', port: 1080 },
  { host: 'p2', port: 1080 }
];
const SETTINGS = { channel: 'c', word: 'w', accountsPerProxy: 1, spreadSeconds: 0, concurrency: 3 };

function fakeGql(overrides = {}) {
  return {
    resolveUserId: overrides.resolveUserId ?? (async () => '999'),
    getFollowedChannels: overrides.getFollowedChannels ?? (async () => [
      { userId: '1', login: 's1', displayName: 'S1', followedAt: 't' }
    ]),
    followUser: overrides.followUser ?? (async () => ({ ok: true, alreadyFollowing: false }))
  };
}

let dir, store;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'follows-'));
  store = new Store(dir);
  await store.write('accounts', ACCOUNTS);
  await store.write('proxies', PROXIES);
  await store.write('settings', SETTINGS);
});

test('listFollows: cache miss → fetches and caches', async () => {
  let resolveCalls = 0, getCalls = 0;
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    resolveUserId: async () => { resolveCalls++; return '111'; },
    getFollowedChannels: async () => { getCalls++; return [{ userId: '1', login: 's1', displayName: 'S1', followedAt: 't' }]; }
  }) });
  const r = await svc.listFollows('user1');
  assert.equal(resolveCalls, 1);
  assert.equal(getCalls, 1);
  assert.equal(r.follows.length, 1);
  assert.equal(typeof r.fetchedAt, 'number');
  assert.equal(r.error, undefined);
});

test('listFollows: cache hit → no refetch', async () => {
  let getCalls = 0;
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    getFollowedChannels: async () => { getCalls++; return []; }
  }) });
  await svc.listFollows('user1');
  await svc.listFollows('user1');
  assert.equal(getCalls, 1);
});

test('listFollows: force=true → refetch', async () => {
  let getCalls = 0;
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    getFollowedChannels: async () => { getCalls++; return []; }
  }) });
  await svc.listFollows('user1');
  await svc.listFollows('user1', { force: true });
  assert.equal(getCalls, 2);
});

test('listFollows: errored entry → refetch on next call', async () => {
  let getCalls = 0;
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    getFollowedChannels: async () => {
      getCalls++;
      if (getCalls === 1) {
        const e = new Error('boom'); e.class = 'token_invalid'; throw e;
      }
      return [];
    }
  }) });
  const r1 = await svc.listFollows('user1');
  assert.equal(r1.error, 'token_invalid');
  await svc.listFollows('user1');   // should refetch since previous errored
  assert.equal(getCalls, 2);
});

test('listFollows: unknown account → throws unknown_account', async () => {
  const svc = createFollowsService({ store, twitchGql: fakeGql() });
  await assert.rejects(
    () => svc.listFollows('nonexistent'),
    (e) => e.message === 'unknown_account'
  );
});

test('listFollows: case-insensitive account lookup', async () => {
  const svc = createFollowsService({ store, twitchGql: fakeGql() });
  await svc.listFollows('USER1');   // capital — should match user1
  const meta = svc.getCacheMetadata();
  assert.equal(meta.length, 1);
  assert.equal(meta[0].login, 'user1');
});

test('refreshOne error: writes to cache with error class, does NOT throw to caller', async () => {
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    resolveUserId: async () => { const e = new Error('boom'); e.class = 'token_invalid'; throw e; }
  }) });
  const r = await svc.listFollows('user1');
  assert.equal(r.error, 'token_invalid');
  assert.equal(r.follows.length, 0);
});

test('refreshAll: no args → refreshes all accounts', async () => {
  let calls = [];
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    resolveUserId: async (login) => { calls.push(login); return '111'; }
  }) });
  const r = await svc.refreshAll();
  assert.equal(r.length, 3);
  assert.deepEqual(calls.sort(), ['user1', 'user2', 'user3']);
  assert.ok(r.every(x => x.ok));
});

test('refreshAll: with logins → refreshes only specified', async () => {
  const calls = [];
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    resolveUserId: async (login) => { calls.push(login); return '111'; }
  }) });
  const r = await svc.refreshAll(['user1', 'user3']);
  assert.equal(r.length, 2);
  assert.deepEqual(calls.sort(), ['user1', 'user3']);
});

test('refreshAll: 409 when another in flight', async () => {
  let release;
  const blocker = new Promise(r => { release = r; });
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    resolveUserId: async () => { await blocker; return '111'; }
  }) });
  const first = svc.refreshAll();
  await new Promise(r => setTimeout(r, 10));
  await assert.rejects(
    () => svc.refreshAll(),
    (e) => e.class === 'refresh_running'
  );
  release();
  await first;
});

test('getCacheMetadata: returns one entry per cached account', async () => {
  const svc = createFollowsService({ store, twitchGql: fakeGql() });
  await svc.listFollows('user1');
  await svc.listFollows('user2');
  const meta = svc.getCacheMetadata();
  assert.equal(meta.length, 2);
  for (const m of meta) {
    assert.ok(['user1', 'user2'].includes(m.login));
    assert.equal(typeof m.fetchedAt, 'number');
    assert.equal(typeof m.count, 'number');
    assert.ok('error' in m);
  }
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/follows.test.js`
Expected: `Cannot find module '../follows.js'`.

- [ ] **Step 3: Implement `follows.js` (cache + listFollows + refreshAll + getCacheMetadata)**

Create `follows.js`:

```js
import pLimit from 'p-limit';
import { assignProxy } from './sender.js';

export function createFollowsService({ store, twitchGql }) {
  const cache = new Map();
  let refreshInFlight = false;
  let followActionInFlight = false;

  function keyFor(login) { return String(login).toLowerCase(); }

  async function findAccount(login) {
    const accounts = await store.read('accounts');
    const idx = accounts.findIndex(a => a.login.toLowerCase() === keyFor(login));
    if (idx < 0) return null;
    return { account: accounts[idx], idx, accounts };
  }

  async function refreshOne(login) {
    const found = await findAccount(login);
    if (!found) throw new Error('unknown_account');
    const { account, idx } = found;
    const [proxies, settings] = await Promise.all([
      store.read('proxies'), store.read('settings')
    ]);
    const proxy = assignProxy(idx, proxies, settings.accountsPerProxy);
    try {
      const userId = await twitchGql.resolveUserId(account.login, { token: account.oauthToken, proxy });
      const follows = await twitchGql.getFollowedChannels(userId, { token: account.oauthToken, proxy });
      const entry = { follows, fetchedAt: Date.now() };
      cache.set(keyFor(account.login), entry);
      return entry;
    } catch (err) {
      const entry = {
        follows: [],
        fetchedAt: Date.now(),
        error: err.class || 'unknown',
        details: err.message
      };
      cache.set(keyFor(account.login), entry);
      return entry;
    }
  }

  async function listFollows(login, { force = false } = {}) {
    const cached = cache.get(keyFor(login));
    if (cached && !force && !cached.error) return cached;
    return refreshOne(login);
  }

  async function refreshAll(logins) {
    if (refreshInFlight) {
      const e = new Error('refresh_running'); e.class = 'refresh_running'; throw e;
    }
    refreshInFlight = true;
    try {
      const settings = await store.read('settings');
      const targets = logins ?? (await store.read('accounts')).map(a => a.login);
      const limit = pLimit(settings.concurrency || 5);
      return Promise.all(targets.map(login =>
        limit(() => refreshOne(login).then(
          entry => ({
            login,
            ok: !entry.error,
            count: entry.follows.length,
            error: entry.error ?? null,
            fetchedAt: entry.fetchedAt
          }),
          err => ({ login, ok: false, error: err.message, fetchedAt: Date.now() })
        ))
      ));
    } finally {
      refreshInFlight = false;
    }
  }

  function getCacheMetadata() {
    return Array.from(cache.entries()).map(([login, e]) => ({
      login,
      fetchedAt: e.fetchedAt,
      count: e.follows.length,
      error: e.error ?? null
    }));
  }

  function getCachedEntry(login) {
    return cache.get(keyFor(login)) ?? null;
  }

  async function followStreamer() {
    // Implemented in Task 3b
    throw new Error('not implemented');
  }

  return { listFollows, refreshAll, followStreamer, getCacheMetadata, getCachedEntry };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test test/follows.test.js`
Expected: 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add follows.js test/follows.test.js
git commit -m "feat(follows): service with listFollows, refreshAll, cache, refresh lock"
```

---

## Task 3b: `follows.js` — followStreamer + follow lock

**Files:**
- Modify: `follows.js`
- Modify: `test/follows.test.js`

- [ ] **Step 1: Append the failing tests**

Append to `test/follows.test.js` (after the last existing test, before EOF):

```js
test('followStreamer: happy path, broadcasterId resolved once, fan-out to each account', async () => {
  let resolveCalls = 0;
  const followCalls = [];
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    resolveUserId: async (login) => { resolveCalls++; return '777'; },
    followUser: async (id, opts) => { followCalls.push({ id, token: opts.token }); return { ok: true, alreadyFollowing: false }; }
  }) });
  const r = await svc.followStreamer('somestream', ['user1', 'user3']);
  assert.equal(r.broadcasterId, '777');
  assert.equal(resolveCalls, 1);
  assert.equal(followCalls.length, 2);
  assert.ok(followCalls.every(c => c.id === '777'));
  assert.equal(r.results.length, 2);
  assert.ok(r.results.every(x => x.ok));
});

test('followStreamer: uses assignProxy by account-index-in-accounts.json, not in-input', async () => {
  // accountsPerProxy: 1 → user1→p1, user2→p2, user3→p1 (cycle)
  const receivedProxies = [];
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    followUser: async (id, opts) => { receivedProxies.push(opts.proxy?.host); return { ok: true, alreadyFollowing: false }; }
  }) });
  // Send user3 first, user1 second — proxies must still match account-index, not input-index
  await svc.followStreamer('s', ['user3', 'user1']);
  assert.deepEqual(receivedProxies, ['p1', 'p1']);   // user3→p1 (idx 2 → 2%2=0 → p1), user1→p1 (idx 0 → p1)
});

test('followStreamer: streamer_not_found at resolve → throws, no followUser calls', async () => {
  let followCalls = 0;
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    resolveUserId: async () => { const e = new Error('nf'); e.class = 'streamer_not_found'; throw e; },
    followUser: async () => { followCalls++; return { ok: true, alreadyFollowing: false }; }
  }) });
  await assert.rejects(
    () => svc.followStreamer('nope', ['user1', 'user2']),
    (e) => e.class === 'streamer_not_found'
  );
  assert.equal(followCalls, 0);
});

test('followStreamer: per-account errors do NOT halt fan-out', async () => {
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    followUser: async (id, opts) => {
      if (opts.token === ACCOUNTS[1].oauthToken.replace(/^oauth:/, '') || opts.token === ACCOUNTS[1].oauthToken) {
        const e = new Error('bad token'); e.class = 'token_invalid'; throw e;
      }
      return { ok: true, alreadyFollowing: false };
    }
  }) });
  const r = await svc.followStreamer('s', ['user1', 'user2', 'user3']);
  assert.equal(r.results.length, 3);
  const failed = r.results.find(x => !x.ok);
  assert.ok(failed, 'one result must be failed');
  assert.equal(failed.login, 'user2');
  assert.equal(failed.error, 'token_invalid');
  assert.equal(r.results.filter(x => x.ok).length, 2);
});

test('followStreamer: unknown_account in list → throws before resolve', async () => {
  let resolveCalls = 0;
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    resolveUserId: async () => { resolveCalls++; return '1'; }
  }) });
  await assert.rejects(
    () => svc.followStreamer('s', ['user1', 'ghost']),
    (e) => e.class === 'unknown_account'
  );
  assert.equal(resolveCalls, 0);
});

test('followStreamer: 409 when another in flight', async () => {
  let release;
  const blocker = new Promise(r => { release = r; });
  const svc = createFollowsService({ store, twitchGql: fakeGql({
    resolveUserId: async () => { await blocker; return '1'; }
  }) });
  const first = svc.followStreamer('s', ['user1']);
  await new Promise(r => setTimeout(r, 10));
  await assert.rejects(
    () => svc.followStreamer('s2', ['user2']),
    (e) => e.class === 'follow_running'
  );
  release();
  await first;
});

test('refreshAll and followStreamer can run in parallel (different locks)', async () => {
  let release1, release2;
  const b1 = new Promise(r => { release1 = r; });
  const b2 = new Promise(r => { release2 = r; });
  let refreshStarted = false, followStarted = false;
  const svc = createFollowsService({ store, twitchGql: {
    resolveUserId: async () => { followStarted = true; await b2; return '1'; },
    getFollowedChannels: async () => { refreshStarted = true; await b1; return []; },
    followUser: async () => ({ ok: true, alreadyFollowing: false })
  } });
  const r = svc.refreshAll(['user1']);
  const f = svc.followStreamer('s', ['user2']);
  await new Promise(r => setTimeout(r, 30));
  // Both should be in flight
  assert.equal(refreshStarted, true);
  assert.equal(followStarted, true);
  release1(); release2();
  await Promise.all([r, f]);
});
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `node --test test/follows.test.js`
Expected: 7 new tests fail (`followStreamer` is the stub that throws "not implemented"); 11 existing tests pass.

- [ ] **Step 3: Implement `followStreamer` in `follows.js`**

In `follows.js`, replace the stub `followStreamer` (`throw new Error('not implemented')`) with:

```js
  async function followStreamer(streamerLogin, accountLogins) {
    if (followActionInFlight) {
      const e = new Error('follow_running'); e.class = 'follow_running'; throw e;
    }
    followActionInFlight = true;
    try {
      const [accounts, proxies, settings] = await Promise.all([
        store.read('accounts'), store.read('proxies'), store.read('settings')
      ]);

      // Validate every account exists in accounts.json (case-insensitive)
      const targets = accountLogins.map(l => {
        const idx = accounts.findIndex(a => a.login.toLowerCase() === keyFor(l));
        return idx >= 0
          ? { account: accounts[idx], proxy: assignProxy(idx, proxies, settings.accountsPerProxy) }
          : null;
      });
      if (targets.some(t => !t)) {
        const e = new Error('unknown_account'); e.class = 'unknown_account'; throw e;
      }

      // Resolve broadcaster ID ONCE, using the first account's token + its proxy
      const first = targets[0];
      const broadcasterId = await twitchGql.resolveUserId(streamerLogin, {
        token: first.account.oauthToken, proxy: first.proxy
      });

      // Fan-out follow with p-limit
      const limit = pLimit(settings.concurrency || 5);
      const results = await Promise.all(targets.map(({ account, proxy }) =>
        limit(async () => {
          try {
            const r = await twitchGql.followUser(broadcasterId, { token: account.oauthToken, proxy });
            return { login: account.login, ok: true, alreadyFollowing: r.alreadyFollowing ?? false };
          } catch (err) {
            return { login: account.login, ok: false, error: err.class || 'unknown', details: err.message };
          }
        })
      ));
      return { broadcasterId, results };
    } finally {
      followActionInFlight = false;
    }
  }
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `node --test test/follows.test.js`
Expected: 18 tests pass (11 + 7 new).

- [ ] **Step 5: Commit**

```bash
git add follows.js test/follows.test.js
git commit -m "feat(follows): followStreamer with broadcaster-id-resolved-once + follow lock"
```

---

## Task 4: API endpoints — 4 new routes + tests

**Files:**
- Modify: `routes/api.js`
- Create: `test/api.follows.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/api.follows.test.js`:

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
import { createFollowsService } from '../follows.js';
import { apiRouter } from '../routes/api.js';

const ACCOUNTS = [
  { login: 'user1', oauthToken: 'oauth:' + 'a'.repeat(30) },
  { login: 'user2', oauthToken: 'oauth:' + 'b'.repeat(30) }
];
const PROXIES = [{ host: 'p1', port: 1080 }];
const SETTINGS = { channel: 'c', word: 'w', accountsPerProxy: 1, spreadSeconds: 0, concurrency: 2 };

function buildApp({ store, followsService }) {
  const sender = createSender({ sendOne: async () => ({ ok: true, durationMs: 1 }) });
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter({ store, sender, followsService }));
  return app;
}

function makeFakeGql(overrides = {}) {
  return {
    resolveUserId: overrides.resolveUserId ?? (async () => '999'),
    getFollowedChannels: overrides.getFollowedChannels ?? (async () => [
      { userId: '1', login: 's1', displayName: 'S1', followedAt: 't' }
    ]),
    followUser: overrides.followUser ?? (async () => ({ ok: true, alreadyFollowing: false }))
  };
}

let dir, store, followsService;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'apifollows-'));
  store = new Store(dir);
  await store.write('accounts', ACCOUNTS);
  await store.write('proxies', PROXIES);
  await store.write('settings', SETTINGS);
  followsService = createFollowsService({ store, twitchGql: makeFakeGql() });
});

test('GET /api/follows: empty cache → empty array', async () => {
  const app = buildApp({ store, followsService });
  const r = await request(app).get('/api/follows');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { cache: [] });
});

test('GET /api/follows: populated cache → metadata for each', async () => {
  await followsService.refreshAll();
  const app = buildApp({ store, followsService });
  const r = await request(app).get('/api/follows');
  assert.equal(r.status, 200);
  assert.equal(r.body.cache.length, 2);
  for (const e of r.body.cache) {
    assert.ok(['user1', 'user2'].includes(e.login));
    assert.equal(typeof e.fetchedAt, 'number');
    assert.equal(typeof e.count, 'number');
    assert.ok('error' in e);
  }
});

test('GET /api/follows/:login: 200 with cached entry', async () => {
  await followsService.listFollows('user1');
  const app = buildApp({ store, followsService });
  const r = await request(app).get('/api/follows/user1');
  assert.equal(r.status, 200);
  assert.equal(r.body.login, 'user1');
  assert.equal(r.body.follows.length, 1);
  assert.equal(typeof r.body.fetchedAt, 'number');
});

test('GET /api/follows/:login: 404 not_cached when account exists but no entry', async () => {
  const app = buildApp({ store, followsService });
  const r = await request(app).get('/api/follows/user1');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'not_cached');
});

test('GET /api/follows/:login: 200 with error field when cached entry has error (no refetch)', async () => {
  let gqlCallCount = 0;
  const svc = createFollowsService({ store, twitchGql: makeFakeGql({
    resolveUserId: async () => {
      gqlCallCount++;
      if (gqlCallCount === 1) { const e = new Error('boom'); e.class = 'token_invalid'; throw e; }
      return '1';   // would return on refetch — but GET must not trigger this
    }
  }) });
  // Prime the cache with an errored entry
  await svc.listFollows('user1');
  assert.equal(gqlCallCount, 1);
  const app = buildApp({ store, followsService: svc });
  const r = await request(app).get('/api/follows/user1');
  assert.equal(r.status, 200);
  assert.equal(r.body.error, 'token_invalid');
  assert.equal(r.body.follows.length, 0);
  // Crucial: GET must NOT have triggered another resolveUserId call
  assert.equal(gqlCallCount, 1);
});

test('GET /api/follows/:login: 404 unknown_account when login not in accounts.json', async () => {
  const app = buildApp({ store, followsService });
  const r = await request(app).get('/api/follows/nobody');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'unknown_account');
});

test('POST /api/follows/refresh: no body → refreshes all', async () => {
  const app = buildApp({ store, followsService });
  const r = await request(app).post('/api/follows/refresh').send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 2);
  assert.ok(r.body.results.every(x => x.ok));
});

test('POST /api/follows/refresh: with logins → refreshes only specified', async () => {
  const app = buildApp({ store, followsService });
  const r = await request(app).post('/api/follows/refresh').send({ logins: ['user1'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 1);
  assert.equal(r.body.results[0].login, 'user1');
});

test('POST /api/follows/refresh: invalid logins → 400', async () => {
  const app = buildApp({ store, followsService });
  const r1 = await request(app).post('/api/follows/refresh').send({ logins: 'nope' });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error, 'invalid_logins');
  const r2 = await request(app).post('/api/follows/refresh').send({ logins: ['ghost'] });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.error, 'invalid_logins');
  const r3 = await request(app).post('/api/follows/refresh').send({ logins: [] });
  assert.equal(r3.status, 400);
});

test('POST /api/follows/refresh: 409 when in flight', async () => {
  let release;
  const blocker = new Promise(r => { release = r; });
  const slowService = createFollowsService({ store, twitchGql: makeFakeGql({
    resolveUserId: async () => { await blocker; return '1'; }
  }) });
  const app = buildApp({ store, followsService: slowService });
  // Eager start via .end() (supertest defers .then-only requests)
  const firstP = new Promise((resolve, reject) => {
    request(app).post('/api/follows/refresh').send({}).end((err, res) => err ? reject(err) : resolve(res));
  });
  await new Promise(r => setTimeout(r, 10));
  const second = await request(app).post('/api/follows/refresh').send({});
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'refresh_running');
  release();
  await firstP;
});

test('POST /api/follows/follow: happy path', async () => {
  const app = buildApp({ store, followsService });
  const r = await request(app).post('/api/follows/follow').send({ streamer: 'foo', logins: ['user1', 'user2'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.broadcasterId, '999');
  assert.equal(r.body.results.length, 2);
  assert.ok(r.body.results.every(x => x.ok));
});

test('POST /api/follows/follow: invalid_streamer (empty, bad chars)', async () => {
  const app = buildApp({ store, followsService });
  const r1 = await request(app).post('/api/follows/follow').send({ streamer: '', logins: ['user1'] });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error, 'invalid_streamer');
  const r2 = await request(app).post('/api/follows/follow').send({ streamer: 'a-b', logins: ['user1'] });
  assert.equal(r2.status, 400);
  const r3 = await request(app).post('/api/follows/follow').send({ streamer: 123, logins: ['user1'] });
  assert.equal(r3.status, 400);
});

test('POST /api/follows/follow: invalid_logins (empty, unknown)', async () => {
  const app = buildApp({ store, followsService });
  const r1 = await request(app).post('/api/follows/follow').send({ streamer: 'foo', logins: [] });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error, 'invalid_logins');
  const r2 = await request(app).post('/api/follows/follow').send({ streamer: 'foo', logins: ['ghost'] });
  assert.equal(r2.status, 400);
  assert.equal(r2.body.error, 'invalid_logins');
  const r3 = await request(app).post('/api/follows/follow').send({ streamer: 'foo', logins: 'oops' });
  assert.equal(r3.status, 400);
});

test('POST /api/follows/follow: streamer_not_found at resolve → 400', async () => {
  const svc = createFollowsService({ store, twitchGql: makeFakeGql({
    resolveUserId: async () => { const e = new Error('nf'); e.class = 'streamer_not_found'; throw e; }
  }) });
  const app = buildApp({ store, followsService: svc });
  const r = await request(app).post('/api/follows/follow').send({ streamer: 'foo', logins: ['user1'] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'streamer_not_found');
});

test('POST /api/follows/follow: network error at resolve → 502', async () => {
  const svc = createFollowsService({ store, twitchGql: makeFakeGql({
    resolveUserId: async () => { const e = new Error('boom'); e.class = 'proxy_unreachable'; throw e; }
  }) });
  const app = buildApp({ store, followsService: svc });
  const r = await request(app).post('/api/follows/follow').send({ streamer: 'foo', logins: ['user1'] });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'proxy_unreachable');
});

test('POST /api/follows/follow: 409 when in flight', async () => {
  let release;
  const blocker = new Promise(r => { release = r; });
  const svc = createFollowsService({ store, twitchGql: makeFakeGql({
    resolveUserId: async () => { await blocker; return '1'; }
  }) });
  const app = buildApp({ store, followsService: svc });
  const firstP = new Promise((resolve, reject) => {
    request(app).post('/api/follows/follow').send({ streamer: 'foo', logins: ['user1'] }).end((err, res) => err ? reject(err) : resolve(res));
  });
  await new Promise(r => setTimeout(r, 10));
  const second = await request(app).post('/api/follows/follow').send({ streamer: 'foo', logins: ['user2'] });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'follow_running');
  release();
  await firstP;
});

test('POST refresh and POST follow can run in parallel', async () => {
  let release1, release2;
  const b1 = new Promise(r => { release1 = r; });
  const b2 = new Promise(r => { release2 = r; });
  const svc = createFollowsService({ store, twitchGql: {
    resolveUserId: async () => { await b1; return '1'; },
    getFollowedChannels: async () => { await b2; return []; },
    followUser: async () => ({ ok: true, alreadyFollowing: false })
  } });
  const app = buildApp({ store, followsService: svc });
  const refreshP = new Promise((resolve, reject) => {
    request(app).post('/api/follows/refresh').send({}).end((err, res) => err ? reject(err) : resolve(res));
  });
  const followP = new Promise((resolve, reject) => {
    request(app).post('/api/follows/follow').send({ streamer: 'foo', logins: ['user1'] }).end((err, res) => err ? reject(err) : resolve(res));
  });
  await new Promise(r => setTimeout(r, 30));
  release1(); release2();
  const [refresh, follow] = await Promise.all([refreshP, followP]);
  assert.equal(refresh.status, 200);
  assert.equal(follow.status, 200);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test test/api.follows.test.js`
Expected: tests fail because `apiRouter` doesn't yet accept `followsService` or expose the routes.

- [ ] **Step 3: Modify `routes/api.js` — add `followsService` DI + 4 endpoints**

Open `routes/api.js`. Current signature:

```js
export function apiRouter({ store, sender, sendOne: sendOneImpl, healthStore, checkOne: checkOneImpl }) {
```

Change to:

```js
export function apiRouter({ store, sender, sendOne: sendOneImpl, healthStore, checkOne: checkOneImpl, followsService }) {
```

At the bottom of the function, AFTER the `r.get('/proxies/health', ...)` endpoint and BEFORE `r.post('/quick-send', ...)`, add:

```js
  // ===== Follows endpoints =====
  const STREAMER_RE = /^[a-zA-Z0-9_]+$/;

  async function loadAccountLoginsLower() {
    const accounts = await store.read('accounts');
    return new Set(accounts.map(a => a.login.toLowerCase()));
  }

  r.get('/follows', (_req, res) => {
    if (!followsService) return res.status(500).json({ error: 'no_follows_service' });
    res.json({ cache: followsService.getCacheMetadata() });
  });

  r.get('/follows/:login', async (req, res) => {
    if (!followsService) return res.status(500).json({ error: 'no_follows_service' });
    const login = req.params.login;
    const validLogins = await loadAccountLoginsLower();
    if (!validLogins.has(login.toLowerCase())) {
      return res.status(404).json({ error: 'unknown_account' });
    }
    // Pure cache read — GET must never trigger a network fetch (even if cached entry has error).
    const entry = followsService.getCachedEntry(login);
    if (!entry) return res.status(404).json({ error: 'not_cached' });
    res.json({
      login: login.toLowerCase(),
      follows: entry.follows,
      fetchedAt: entry.fetchedAt,
      error: entry.error ?? null
    });
  });

  r.post('/follows/refresh', async (req, res) => {
    if (!followsService) return res.status(500).json({ error: 'no_follows_service' });
    const body = req.body || {};
    const validLogins = await loadAccountLoginsLower();
    let logins;
    if (body.logins !== undefined) {
      if (!Array.isArray(body.logins) || body.logins.length === 0) {
        return res.status(400).json({ error: 'invalid_logins' });
      }
      if (!body.logins.every(l => typeof l === 'string' && validLogins.has(l.toLowerCase()))) {
        return res.status(400).json({ error: 'invalid_logins' });
      }
      logins = body.logins;
    }
    try {
      const results = await followsService.refreshAll(logins);
      res.json({ results });
    } catch (err) {
      if (err.class === 'refresh_running') return res.status(409).json({ error: 'refresh_running' });
      res.status(500).json({ error: 'unexpected', details: err.message });
    }
  });

  r.post('/follows/follow', async (req, res) => {
    if (!followsService) return res.status(500).json({ error: 'no_follows_service' });
    const { streamer, logins } = req.body || {};
    if (typeof streamer !== 'string' || !STREAMER_RE.test(streamer.trim())) {
      return res.status(400).json({ error: 'invalid_streamer' });
    }
    if (!Array.isArray(logins) || logins.length === 0) {
      return res.status(400).json({ error: 'invalid_logins' });
    }
    const validLogins = await loadAccountLoginsLower();
    if (!logins.every(l => typeof l === 'string' && validLogins.has(l.toLowerCase()))) {
      return res.status(400).json({ error: 'invalid_logins' });
    }
    try {
      const result = await followsService.followStreamer(streamer.trim(), logins);
      res.json(result);
    } catch (err) {
      if (err.class === 'follow_running') return res.status(409).json({ error: 'follow_running' });
      if (err.class === 'streamer_not_found') return res.status(400).json({ error: 'streamer_not_found' });
      if (err.class === 'unknown_account') return res.status(400).json({ error: 'invalid_logins' });
      if (['proxy_unreachable', 'twitch_unreachable', 'timeout', 'token_invalid', 'rate_limited'].includes(err.class)) {
        return res.status(502).json({ error: err.class, details: err.message });
      }
      res.status(500).json({ error: 'unexpected', details: err.message });
    }
  });
```

- [ ] **Step 4: Run new tests, verify they pass**

Run: `node --test test/api.follows.test.js`
Expected: 16 tests pass.

- [ ] **Step 5: Verify existing api tests still pass**

Run: `node --test test/api.test.js test/api.proxies.health.test.js`
Expected: still green. (Existing routers called without `followsService` still work; the new arg is optional.)

- [ ] **Step 6: Commit**

```bash
git add routes/api.js test/api.follows.test.js
git commit -m "feat(follows): 4 API endpoints (GET list, GET one, POST refresh, POST follow)"
```

---

## Task 5: Wire `followsService` into `server.js`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Edit `server.js`**

In `server.js`, find the imports near the top, e.g.:

```js
import { createHealthStore } from './healthStore.js';
```

Add directly below:

```js
import { createFollowsService } from './follows.js';
import * as twitchGql from './twitchGql.js';
```

Find the line that creates `healthStore`:

```js
const healthStore = createHealthStore();
```

Add right below:

```js
const followsService = createFollowsService({ store, twitchGql });
```

Find the apiRouter mount:

```js
app.use('/api', requireAuth, csrf, apiRouter({ store, sender, healthStore }));
```

Change to:

```js
app.use('/api', requireAuth, csrf, apiRouter({ store, sender, healthStore, followsService }));
```

- [ ] **Step 2: Verify server boots**

Bash:
```bash
node server.js > /tmp/srv.log 2>&1 &
SERVER_PID=$!
sleep 2
kill $SERVER_PID 2>/dev/null
cat /tmp/srv.log
rm /tmp/srv.log
```

Expected: log line `listening http://127.0.0.1:3000` (or whatever PORT) before kill, no module-load errors.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(follows): wire followsService into server"
```

---

## Task 6: Extract `relativeTime` to `frontend/src/lib/time.ts`

**Files:**
- Create: `frontend/src/lib/time.ts`
- Modify: `frontend/src/pages/ProxiesPage.tsx`

- [ ] **Step 1: Create the shared helper**

Create `frontend/src/lib/time.ts`:

```ts
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return 'только что';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} сек назад`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`;
  return `${Math.floor(diff / 86_400_000)} дн назад`;
}
```

- [ ] **Step 2: Update `ProxiesPage.tsx` to use the shared helper**

In `frontend/src/pages/ProxiesPage.tsx`, find the inline `relativeTime` function (just below the imports) and DELETE it.

Then add to the existing import block at the top of the file:

```ts
import { relativeTime } from '@/lib/time';
```

- [ ] **Step 3: Verify TypeScript build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/time.ts frontend/src/pages/ProxiesPage.tsx
git commit -m "refactor(spa): extract relativeTime to lib/time.ts for reuse"
```

---

## Task 7: `api.ts` — follow types

**Files:**
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Append types to `api.ts`**

In `frontend/src/lib/api.ts`, after the existing `ProxyCheckResponse` type (around the end of the type block, before the `request` function), add:

```ts
export type Follow = {
  userId: string;
  login: string;
  displayName: string;
  followedAt: string;
};

export type FollowsCacheMetadata = {
  login: string;
  fetchedAt: number;
  count: number;
  error: string | null;
};

export type FollowsCacheResponse = { cache: FollowsCacheMetadata[] };

export type FollowsCacheEntry = {
  login: string;
  follows: Follow[];
  fetchedAt: number;
  error: string | null;
};

export type RefreshResult = {
  login: string;
  ok: boolean;
  count?: number;
  error?: string | null;
  fetchedAt: number;
};

export type RefreshResponse = { results: RefreshResult[] };

export type FollowActionResult = {
  login: string;
  ok: boolean;
  alreadyFollowing?: boolean;
  error?: string;
  details?: string;
};

export type FollowActionResponse = {
  broadcasterId: string;
  results: FollowActionResult[];
};
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat(spa): follow-related types in api.ts"
```

---

## Task 8: `error-labels.ts` — add new keys

**Files:**
- Modify: `frontend/src/lib/error-labels.ts`

- [ ] **Step 1: Add the new entries**

In `frontend/src/lib/error-labels.ts`, inside the existing `ERROR_LABELS` const object, add these new entries (placement: append at the end of the object, before the closing `}`):

```ts
  streamer_not_found: 'Стример не найден',
  already_following: 'Уже подписан',
  rate_limited: 'Twitch: слишком много запросов',
  refresh_running: 'Обновление уже идёт',
  follow_running: 'Follow уже идёт',
  not_cached: 'Список ещё не загружен',
  invalid_streamer: 'Неверный логин стримера',
  invalid_logins: 'Неверный список аккаунтов'
```

Make sure the previous entry has a trailing comma. The existing entry `unknown_account: 'Аккаунт не найден'` is already there from prior work — do NOT add a duplicate.

- [ ] **Step 2: Verify TS build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/error-labels.ts
git commit -m "feat(spa): error labels for follows feature"
```

---

## Task 9: `FollowsPage.tsx` shell + route + nav

**Files:**
- Create: `frontend/src/pages/FollowsPage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/Nav.tsx`

- [ ] **Step 1: Create the empty page shell**

Create `frontend/src/pages/FollowsPage.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export default function FollowsPage() {
  return (
    <div className="container mx-auto py-6 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Follow streamer</CardTitle>
          <CardDescription>Подписаться выбранными аккаунтами на стримера.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">TBD — форма в Task 11.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account follows</CardTitle>
          <CardDescription>Кто на кого подписан, обновление on-demand.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">TBD — таблица в Task 10.</p>
        </CardContent>
      </Card>
    </div>
  );
}
```

(Yes, these TBDs are temporary scaffold text — they will be replaced in Tasks 10 and 11. They are NOT plan placeholders.)

- [ ] **Step 2: Add route in `App.tsx`**

In `frontend/src/App.tsx`, find the existing `<Routes>` block with `<Route path="/proxies" ... />` etc.

Add the import at the top alongside other page imports:

```tsx
import FollowsPage from '@/pages/FollowsPage';
```

Inside `<Routes>`, add a new `<Route>` (e.g. right after the Proxies route):

```tsx
<Route path="/follows" element={<FollowsPage />} />
```

- [ ] **Step 3: Add nav link in `Nav.tsx`**

In `frontend/src/components/Nav.tsx`, find the existing nav items (e.g. links to `/accounts`, `/proxies`, `/settings`).

Add a new link between `/proxies` and `/settings`. The exact pattern depends on the existing markup — replicate the surrounding link's JSX. For example, if the existing link is:

```tsx
<Link to="/proxies" className="...">Proxies</Link>
```

Add directly below:

```tsx
<Link to="/follows" className="...">Follows</Link>
```

(Copy the exact `className` from the sibling link to maintain styling consistency.)

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/FollowsPage.tsx frontend/src/App.tsx frontend/src/components/Nav.tsx
git commit -m "feat(spa): FollowsPage shell + route + nav link"
```

---

## Task 10: `FollowsPage.tsx` — Account follows table (with hook + per-row controls)

**Files:**
- Modify: `frontend/src/pages/FollowsPage.tsx`

- [ ] **Step 1: Rewrite `FollowsPage.tsx` to implement the Account follows table**

Replace the entire contents of `frontend/src/pages/FollowsPage.tsx` with:

```tsx
import { useCallback, useEffect, useState, Fragment } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RefreshCw, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  api,
  type Account,
  type Follow,
  type FollowsCacheMetadata,
  type FollowsCacheResponse,
  type FollowsCacheEntry,
  type RefreshResponse
} from '@/lib/api';
import { errLabel } from '@/lib/error-labels';
import { relativeTime } from '@/lib/time';

function useFollowsCache() {
  const [meta, setMeta] = useState<Record<string, FollowsCacheMetadata>>({});
  const refresh = useCallback(async () => {
    const r = await api.get<FollowsCacheResponse>('/api/follows');
    if (r) setMeta(Object.fromEntries(r.cache.map(e => [e.login.toLowerCase(), e])));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { meta, refresh };
}

export default function FollowsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const { meta, refresh: refreshMeta } = useFollowsCache();
  const [refreshing, setRefreshing] = useState(false);
  const [loadingPerAccount, setLoadingPerAccount] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [accountFollows, setAccountFollows] = useState<Record<string, Follow[]>>({});

  useEffect(() => {
    api.get<Account[]>('/api/accounts').then(a => { if (a) setAccounts(a); });
  }, []);

  const neverLoadedCount = accounts.filter(a => !meta[a.login.toLowerCase()]).length;

  const runRefresh = async (logins?: string[]) => {
    const isGlobal = !logins;
    if (isGlobal) {
      if (refreshing) return;
      setRefreshing(true);
    } else {
      const login = logins[0];
      if (loadingPerAccount[login]) return;
      setLoadingPerAccount(prev => ({ ...prev, [login]: true }));
    }
    try {
      const res = await api.request<RefreshResponse>('POST', '/api/follows/refresh', logins ? { logins } : {});
      if (res.ok) {
        const ok = res.data.results.filter(r => r.ok).length;
        const failed = res.data.results.length - ok;
        toast.success(`Обновлено: ${ok} ok, ${failed} fail`);
        await refreshMeta();
        // Drop client-side full lists so they re-fetch on next expand
        if (isGlobal) setAccountFollows({});
        else setAccountFollows(prev => { const c = { ...prev }; delete c[logins[0]]; return c; });
      } else if (res.err.status === 409) {
        toast.error(errLabel('refresh_running'));
      } else {
        toast.error(errLabel(res.err.error) || `HTTP ${res.err.status}`);
      }
    } finally {
      if (isGlobal) setRefreshing(false);
      else setLoadingPerAccount(prev => ({ ...prev, [logins[0]]: false }));
    }
  };

  const toggleExpanded = async (login: string) => {
    const willOpen = !expanded[login];
    setExpanded(prev => ({ ...prev, [login]: willOpen }));
    if (willOpen && !accountFollows[login]) {
      const r = await api.request<FollowsCacheEntry>('GET', `/api/follows/${encodeURIComponent(login)}`);
      if (r.ok) {
        setAccountFollows(prev => ({ ...prev, [login]: r.data.follows }));
      } else if (r.err.status === 404 && r.err.error === 'not_cached') {
        toast.error(errLabel('not_cached'));
      } else {
        toast.error(errLabel(r.err.error) || `HTTP ${r.err.status}`);
      }
    }
  };

  return (
    <div className="container mx-auto py-6 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Follow streamer</CardTitle>
          <CardDescription>Подписаться выбранными аккаунтами на стримера.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">Форма появится в следующей задаче.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account follows</CardTitle>
          <CardDescription>Кто на кого подписан. Обновление on-demand.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <Button onClick={() => runRefresh()} variant="secondary" disabled={refreshing}>
              {refreshing ? 'Обновление…' : 'Refresh all'}
            </Button>
            {neverLoadedCount > 0 && (
              <span className="text-sm text-muted-foreground">
                {neverLoadedCount} never loaded
              </span>
            )}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Login</TableHead>
                <TableHead className="w-[200px]">Status</TableHead>
                <TableHead className="w-[140px]">Last loaded</TableHead>
                <TableHead className="w-[110px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map(a => {
                const m = meta[a.login.toLowerCase()];
                const isExpanded = expanded[a.login] ?? false;
                const canExpand = m && !m.error && m.count > 0;
                return (
                  <Fragment key={a.login}>
                    <TableRow>
                      <TableCell>{a.login}</TableCell>
                      <TableCell>
                        {!m ? <span className="text-muted-foreground">— never loaded</span>
                          : m.error ? <Badge variant="destructive">× {errLabel(m.error) || m.error}</Badge>
                          : <Badge variant="default">{m.count} follows</Badge>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {m ? relativeTime(m.fetchedAt) : '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => runRefresh([a.login])}
                            disabled={!!loadingPerAccount[a.login] || refreshing}
                            title="Refresh"
                          >
                            <RefreshCw className={cn('h-4 w-4', loadingPerAccount[a.login] && 'animate-spin')} />
                          </Button>
                          {canExpand && (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => toggleExpanded(a.login)}
                              title={isExpanded ? 'Collapse' : 'Expand'}
                            >
                              <ChevronDown className={cn('h-4 w-4 transition-transform', isExpanded && 'rotate-180')} />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    {isExpanded && accountFollows[a.login] && (
                      <TableRow>
                        <TableCell colSpan={4} className="bg-muted/30">
                          <ScrollArea className="h-[300px]">
                            <div className="space-y-1 py-2">
                              {accountFollows[a.login].map(f => (
                                <div key={f.userId} className="flex justify-between text-sm border-b pb-1">
                                  <span>
                                    {f.displayName}{' '}
                                    <span className="text-muted-foreground">({f.login})</span>
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    {relativeTime(new Date(f.followedAt).getTime())}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
              {accounts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    Аккаунтов нет. Добавь их на /accounts.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/FollowsPage.tsx
git commit -m "feat(spa): FollowsPage account follows table with refresh + expand"
```

---

## Task 11: `FollowsPage.tsx` — Follow streamer form (with results)

**Files:**
- Modify: `frontend/src/pages/FollowsPage.tsx`

- [ ] **Step 1: Add form state, helper, and replace the first card**

In `frontend/src/pages/FollowsPage.tsx`:

**(a) Extend imports** — add to the existing `lucide-react` import:

```tsx
import { RefreshCw, ChevronDown } from 'lucide-react';
```

Change to:

```tsx
import { RefreshCw, ChevronDown, UserPlus } from 'lucide-react';
```

Add to the existing `@/lib/api` import:

```tsx
import { type FollowActionResponse, type FollowActionResult } from '@/lib/api';
```

(Merge into the existing import line; final line should list all needed types.)

Add a new import for the Input component:

```tsx
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
```

**(b) Add state and helper** — just inside the `FollowsPage` component, after the existing `useState` lines, add:

```tsx
const [streamer, setStreamer] = useState('');
const [selected, setSelected] = useState<Set<string>>(new Set());
const [following, setFollowing] = useState(false);
const [followResults, setFollowResults] = useState<FollowActionResult[] | null>(null);

const isValidStreamer = /^[a-zA-Z0-9_]+$/.test(streamer.trim());
const allSelected = accounts.length > 0 && selected.size === accounts.length;

const toggleAccount = (login: string, checked: boolean) => {
  setSelected(prev => {
    const next = new Set(prev);
    if (checked) next.add(login);
    else next.delete(login);
    return next;
  });
};

const toggleAll = () => {
  if (allSelected) setSelected(new Set());
  else setSelected(new Set(accounts.map(a => a.login)));
};

const runFollow = async () => {
  if (!isValidStreamer || selected.size === 0 || following) return;
  setFollowing(true);
  setFollowResults(null);
  try {
    const res = await api.request<FollowActionResponse>('POST', '/api/follows/follow', {
      streamer: streamer.trim(),
      logins: Array.from(selected)
    });
    if (res.ok) {
      setFollowResults(res.data.results);
      const ok = res.data.results.filter(r => r.ok).length;
      const failed = res.data.results.length - ok;
      toast.success(`Follow: ${ok} ok, ${failed} fail`);
    } else {
      toast.error(errLabel(res.err.error) || `HTTP ${res.err.status}`);
    }
  } finally {
    setFollowing(false);
  }
};
```

**(c) Replace the first Card** — find the existing first Card (`Follow streamer` with the placeholder paragraph) and replace its `<CardContent>` body with:

```tsx
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="streamer-login">Streamer login</Label>
            <Input
              id="streamer-login"
              value={streamer}
              onChange={e => setStreamer(e.target.value)}
              placeholder="напр. xqc"
              autoComplete="off"
            />
            {streamer && !isValidStreamer && (
              <p className="text-xs text-destructive">Только буквы, цифры, подчёркивание.</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Аккаунты ({selected.size} выбрано)</Label>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {accounts.length > 0 && (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                  />
                  <span className="font-medium">Select all</span>
                </label>
              )}
              {accounts.map(a => (
                <label key={a.login} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(a.login)}
                    onChange={e => toggleAccount(a.login, e.target.checked)}
                  />
                  <span>{a.login}</span>
                </label>
              ))}
              {accounts.length === 0 && (
                <span className="text-sm text-muted-foreground">Аккаунтов нет.</span>
              )}
            </div>
          </div>

          <Button
            onClick={runFollow}
            disabled={!isValidStreamer || selected.size === 0 || following}
          >
            <UserPlus className="h-4 w-4 mr-2" />
            {following ? 'Следую…' : `Follow (${selected.size})`}
          </Button>

          {followResults && (
            <div className="pt-2 border-t">
              <p className="text-sm font-medium mb-2">Результаты:</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Аккаунт</TableHead>
                    <TableHead className="w-[200px]">Результат</TableHead>
                    <TableHead>Подробности</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {followResults.map(r => (
                    <TableRow key={r.login}>
                      <TableCell>{r.login}</TableCell>
                      <TableCell>
                        {r.ok
                          ? (r.alreadyFollowing
                              ? <Badge variant="secondary">уже подписан</Badge>
                              : <Badge variant="default">✓ follow</Badge>)
                          : <Badge variant="destructive">× {errLabel(r.error) || r.error}</Badge>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.details || ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
```

- [ ] **Step 2: Verify TypeScript build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/FollowsPage.tsx
git commit -m "feat(spa): Follow streamer form with multi-account select and results table"
```

---

## Task 12: Update `docs/next-steps.md`

**Files:**
- Modify: `docs/next-steps.md`

- [ ] **Step 1: Append a new section after Шаг 3.5**

Open `docs/next-steps.md`. After the section "Шаг 3.5. Health-check прокси (новая фича)" (added in the previous plan), insert a new section right before the next `---` separator (which precedes Шаг 4):

```markdown
---

## Шаг 3.6. Follows-страница (новая фича)

Цель: убедиться, что список follows и follow-действие работают через прокси.

1. На `/follows` нажми **Refresh all** — спустя несколько секунд таблица должна показать `N follows` для каждого живого аккаунта, или `× <error>` для дохлых.
2. Раскрой строку любого аккаунта чевроном — должен подгрузиться список каналов, на которые он подписан.
3. В верхней карточке **Follow streamer** введи ник существующего стримера (например `xqc`), отметь несколько аккаунтов или **Select all**, нажми **Follow**.
4. **Ожидаемо:** через ~1–3 сек появится таблица результатов: `✓ follow` для новых подписок, `уже подписан` для уже подписанных, `× <error>` для упавших.
5. На самом аккаунте можно зайти в Twitch и убедиться, что `xqc` (или кого вводил) появился в Following.
6. Если падает `streamer_not_found` — проверь, что ник написан без опечаток и не забанен.
7. Если падает `proxy_unreachable` / `twitch_unreachable` — проверь прокси (Шаг 3.5).
```

- [ ] **Step 2: Commit**

```bash
git add docs/next-steps.md
git commit -m "docs: add follows-page smoke-test step"
```

---

## Final Verification

- [ ] **Step 1: Run focused tests**

Run: `node --test test/twitchGql.test.js test/follows.test.js test/api.follows.test.js test/healthStore.test.js test/proxyHealth.test.js test/api.proxies.health.test.js`
Expected: all pass (~46 new + 18 from previous health work = 64 focused tests).

- [ ] **Step 2: SPA build**

Run: `npm run build`
Expected: clean `dist/` build.

- [ ] **Step 3: Boot the server**

Run: `npm start`
Visit `http://127.0.0.1:3000/follows`, log in, exercise per the smoke-test in `docs/next-steps.md` Step 3.6.

- [ ] **Step 4: Scope confirmation**

Skim the spec sections 2 (functional reqs) and 12 (out of scope):
- New `/follows` page with two sections ✓ (Tasks 9, 10, 11)
- Form: streamer input + multi-account select + Follow ✓ (Task 11)
- Table: per-account status, refresh icons, expand chevron ✓ (Task 10)
- All Twitch calls through SOCKS5 via `assignProxy` ✓ (Tasks 1, 2, 3a)
- Two independent locks (refresh + follow) ✓ (Task 3b)
- `broadcasterId` resolved once per action ✓ (Task 3b)
- Per-account errors do not halt fan-out ✓ (Task 3b)
- 409 on concurrent same-action ✓ (Tasks 3a, 3b, 4)
- Russian UI strings ✓ (Tasks 8, 9, 10, 11, 12)
- NOT added: unfollow, streamer typeahead, persistent cache, background refresh, broadcasterId cache, AbortController, per-account proxy-health preflight, auto-refresh after follow, notifications toggle ✓
