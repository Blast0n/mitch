# Stop bulk + Shuffle order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bulk-send interruptible (Quick send auto-stops it; add a manual Stop button) and randomize account send order on every bulk run while keeping each account bound to its proxy.

**Architecture:** `sender.js` gains a pure `shuffle()` (Fisher–Yates), randomizes the *order/timing* of sends while calling `assignProxy` by each account's original index, and gains a `stop(jobId)` method that cancels not-yet-started tasks via tracked timers (in-flight `sendOne` calls finish naturally). `routes/api.js` makes `POST /api/quick-send` stop a running bulk instead of returning 409, and adds `POST /api/send/stop`. Frontend exposes a Stop button and renders a neutral `stopped` row state.

**Tech Stack:** Node.js ESM, Express, `p-limit`, `node:test` + `assert` + `supertest` (backend tests); React + TypeScript + Vite + shadcn/ui (frontend, no unit tests — verified via `npm run build`).

**Spec:** [`docs/superpowers/specs/2026-05-31-stop-bulk-and-shuffle-design.md`](../specs/2026-05-31-stop-bulk-and-shuffle-design.md)

---

## File Structure

**Backend (modify):**
- `sender.js` — add `shuffle` export, `rng` injection, random order in `start()`, `stop()` method, `stopped` in summary.
- `routes/api.js` — `quick-send` auto-stop; new `POST /api/send/stop`; progress-replay handles terminal `stopped` status.
- `test/sender.test.js` — add shuffle / order / stop tests.
- `test/api.test.js` — change the old `quick-send 409` test to assert auto-stop; add `/api/send/stop` tests.

**Frontend (modify):**
- `frontend/src/lib/api.ts` — `stopped` on progress result + summary; `StopResponse`.
- `frontend/src/lib/error-labels.ts` — `stopped`, `not_running` labels.
- `frontend/src/components/ProgressTable.tsx` — render `kind: 'stopped'`.
- `frontend/src/components/JobStats.tsx` — show `stopped` counter.
- `frontend/src/components/QuickSend.tsx` — drop the "wait for bulk" disabled text.
- `frontend/src/pages/MainPage.tsx` — `QuickSend` always enabled, Stop button, `stopped` row/count derivation, stop handler.

**Docs:**
- `docs/next-steps.md` — add manual smoke-test step.

---

## Task 1: `shuffle` pure function in `sender.js`

**Files:**
- Modify: `sender.js` (add export near `assignProxy`)
- Test: `test/sender.test.js`

- [ ] **Step 1: Write the failing test**

Add to the end of `test/sender.test.js`:

```js
import { shuffle } from '../sender.js';

test('shuffle: deterministic with injected rng', () => {
  // Fisher–Yates with rng()=0 always: [0,1,2] -> [1,2,0]
  assert.deepEqual(shuffle([0, 1, 2], () => 0), [1, 2, 0]);
});

test('shuffle: result is a permutation of the input', () => {
  const out = shuffle([0, 1, 2, 3, 4], () => 0.5);
  assert.deepEqual([...out].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

test('shuffle: does not mutate input', () => {
  const input = [0, 1, 2];
  shuffle(input, () => 0);
  assert.deepEqual(input, [0, 1, 2]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `shuffle` is not exported (`The requested module '../sender.js' does not provide an export named 'shuffle'`).

- [ ] **Step 3: Implement `shuffle`**

In `sender.js`, add immediately after the `assignProxy` function (after line 8):

```js
export function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all three `shuffle` tests green, existing tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add sender.js test/sender.test.js
git commit -m "feat(sender): add pure Fisher–Yates shuffle helper"
```

---

## Task 2: Random order + stop() in `sender.js`

This rewrites the job-creation loop in `start()` once, to its final form: shuffled order (proxy bound to original index), tracked tasks, a `markStopped` helper, the `stop()` method, and `stopped` in the summary.

**Files:**
- Modify: `sender.js` — `createSender` signature, `start()` body, new `stop()`, returned object.
- Test: `test/sender.test.js`

- [ ] **Step 1: Write the failing order test**

Add to `test/sender.test.js`:

```js
test('start: randomizes send order but keeps proxy bound to original index', async () => {
  const calls = []; // { login, proxyHost }
  const sendOne = async (account, proxy) => {
    calls.push({ login: account.login, proxyHost: proxy ? proxy.host : null });
    return { ok: true, durationMs: 1 };
  };
  // rng()=0 -> shuffle([0,1,2]) = [1,2,0]
  const sender = createSender({ sendOne, rng: () => 0 });
  const accounts = [
    { login: 'a0', oauthToken: 'oauth:0' },
    { login: 'a1', oauthToken: 'oauth:1' },
    { login: 'a2', oauthToken: 'oauth:2' }
  ];
  const proxies = [{ host: 'p0' }, { host: 'p1' }, { host: 'p2' }];
  sender.start({ accounts, proxies, settings: { ...settings, accountsPerProxy: 1, concurrency: 1, spreadSeconds: 0 } });
  await new Promise(r => setTimeout(r, 50));
  // order of logins follows the shuffled index order [1,2,0]
  assert.deepEqual(calls.map(c => c.login), ['a1', 'a2', 'a0']);
  // each account still uses the proxy at its ORIGINAL index
  const byLogin = Object.fromEntries(calls.map(c => [c.login, c.proxyHost]));
  assert.equal(byLogin.a0, 'p0');
  assert.equal(byLogin.a1, 'p1');
  assert.equal(byLogin.a2, 'p2');
});
```

- [ ] **Step 2: Write the failing stop tests**

Add to `test/sender.test.js`:

```js
test('stop: cancels not-yet-started tasks, in-flight finishes, done reports stopped', async () => {
  let started = 0;
  const gate = deferred(); // first sendOne hangs until released
  const sendOne = async () => { started++; await gate.p; return { ok: true, durationMs: 1 }; };
  const sender = createSender({ sendOne });
  const accounts = Array.from({ length: 4 }, (_, i) => ({ login: 'a' + i, oauthToken: 'oauth:' + i }));
  const events = [];
  // big spread so only pos 0 fires immediately; pos 1..3 stay pending
  const { jobId } = sender.start({ accounts, proxies: [], settings: { ...settings, concurrency: 1, spreadSeconds: 40 } });
  sender.subscribe(jobId, (e) => events.push(e));
  await new Promise(r => setTimeout(r, 20)); // let pos 0 enter sendOne
  assert.equal(started, 1, 'exactly one send in flight');
  assert.equal(sender.stop(jobId), true);
  assert.equal(sender.isRunning(), false, 'no longer running after stop');
  gate.resolve(); // let the in-flight send finish
  await new Promise(r => setTimeout(r, 20));
  assert.equal(started, 1, 'cancelled tasks never called sendOne');
  const done = events.find(e => e.type === 'done');
  assert.ok(done, 'done emitted after stop');
  assert.equal(done.summary.total, 4);
  assert.equal(done.summary.ok, 1);
  assert.equal(done.summary.stopped, 3);
  assert.equal(done.summary.failed, 0);
  // cancelled accounts emit progress with stopped:true
  const stoppedEvents = events.filter(e => e.type === 'progress' && e.result.stopped === true);
  assert.equal(stoppedEvents.length, 3);
});

test('stop: returns false for wrong or finished jobId', async () => {
  const sender = createSender({ sendOne: async () => ({ ok: true, durationMs: 1 }) });
  assert.equal(sender.stop('no-such-job'), false);
  const { jobId } = sender.start({ accounts: [{ login: 'a', oauthToken: 'oauth:1' }], proxies: [], settings });
  await new Promise(r => setTimeout(r, 50)); // job completes (spreadSeconds 0)
  assert.equal(sender.stop(jobId), false, 'finished job cannot be stopped');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — order test fails (current code sends in stored order `a0,a1,a2`); stop tests fail (`sender.stop is not a function`).

- [ ] **Step 4: Rewrite `sender.js`**

Replace the entire `createSender` function body (current `sender.js` lines 10–103) with:

```js
export function createSender({ sendOne, rng = Math.random }) {
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
      startedAt: Date.now(),
      cancelled: false,
      pendingTasks: new Set()
    };
    currentJob = job;
    listenersByJob.set(jobId, new Set());

    const limit = pLimit(Math.max(1, settings.concurrency || 1));
    const interval = (settings.spreadSeconds * 1000) / Math.max(1, accounts.length);

    function markStopped(task) {
      if (task.done) return;
      task.done = true;
      job.results.push({ login: task.account.login, proxy: task.proxyLabel, ok: false, stopped: true });
      emit(jobId, { type: 'progress', login: task.account.login, proxy: task.proxyLabel, result: { ok: false, stopped: true } });
      task.resolve();
    }
    job.markStopped = markStopped;

    const order = shuffle(accounts.map((_, i) => i), rng);
    const tasks = order.map((accIdx, pos) => {
      const account = accounts[accIdx];
      const proxy = assignProxy(accIdx, proxies, settings.accountsPerProxy);
      const proxyLabel = proxy ? `${proxy.host}:${proxy.port}` : 'direct';
      const delay = pos * interval;
      return new Promise((resolve) => {
        const task = { timer: null, resolve, account, proxyLabel, done: false };
        task.timer = setTimeout(() => {
          job.pendingTasks.delete(task);
          if (job.cancelled) return markStopped(task);
          limit(async () => {
            emit(jobId, { type: 'sending', login: account.login, proxy: proxyLabel });
            const result = await sendOne(account, proxy, settings.channel, settings.word, {
              onStage: (stage) => emit(jobId, { type: 'stage', login: account.login, stage })
            });
            const entry = { login: account.login, proxy: proxyLabel, ...result };
            job.results.push(entry);
            emit(jobId, { type: 'progress', login: account.login, proxy: proxyLabel, result });
          }).then(resolve, resolve);
        }, delay);
        job.pendingTasks.add(task);
      });
    });

    Promise.all(tasks).then(() => {
      if (job.status === 'running') job.status = 'done';
      const ok = job.results.filter(r => r.ok).length;
      const stopped = job.results.filter(r => r.stopped).length;
      const failed = job.results.length - ok - stopped;
      const summary = { total: accounts.length, ok, failed, stopped };
      emit(jobId, { type: 'done', jobId, summary });
      setTimeout(() => {
        listenersByJob.delete(jobId);
        if (currentJob?.jobId === jobId) currentJob = null;
      }, 5 * 60 * 1000);
    });

    return { jobId };
  }

  function stop(jobId) {
    if (!currentJob || currentJob.jobId !== jobId || currentJob.status !== 'running') return false;
    const job = currentJob;
    job.cancelled = true;
    job.status = 'stopped';
    for (const task of job.pendingTasks) {
      clearTimeout(task.timer);
      job.markStopped(task);
    }
    job.pendingTasks.clear();
    return true;
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
    return currentJob.results.filter(r => !r.ok && !r.stopped).map(r => r.login);
  }

  function isRunning() {
    return currentJob?.status === 'running';
  }

  function lastJobId() {
    return currentJob?.jobId ?? null;
  }

  return { start, stop, subscribe, getSnapshot, getFailedLogins, isRunning, lastJobId };
}
```

Note: `getFailedLogins` now excludes `stopped` entries so a stopped job's "retry failed" only retries genuine failures, not cancelled accounts.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — new order/stop tests green; existing sender tests (`happy path`, `rejects second start`, `respects concurrency`, `failed results captured`, `forwards stage events`) still green.

- [ ] **Step 6: Commit**

```bash
git add sender.js test/sender.test.js
git commit -m "feat(sender): random send order + stop() cancellation"
```

---

## Task 3: API — quick-send auto-stop + `POST /api/send/stop`

**Files:**
- Modify: `routes/api.js` — `quick-send` handler (lines 73–90), progress replay (lines 144–155), add `/send/stop`.
- Test: `test/api.test.js` — replace the `quick-send 409` test; add stop tests.

- [ ] **Step 1: Replace the obsolete `quick-send 409` test**

In `test/api.test.js`, delete the whole test `POST /api/quick-send 409 when bulk job running` (lines 167–180) and replace it with:

```js
test('POST /api/quick-send stops a running bulk job, then sends', async () => {
  const { app: a, store: s, sender } = buildAppWith(async () => ({ ok: true, durationMs: 1 }));
  await s.write('accounts', [
    { login: 'alice', oauthToken: 'oauth:' + 'a'.repeat(30) },
    { login: 'bob', oauthToken: 'oauth:' + 'b'.repeat(30) },
    { login: 'carol', oauthToken: 'oauth:' + 'c'.repeat(30) }
  ]);
  // large spread => bulk stays running (pending timers) right after start
  await s.write('settings', { channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: 60, concurrency: 1 });
  await request(a).post('/api/send').send({}).expect(202);
  assert.equal(sender.isRunning(), true, 'bulk running before quick-send');
  const r = await request(a).post('/api/quick-send').send({ login: 'alice', message: 'hi' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(sender.isRunning(), false, 'bulk stopped by quick-send');
});
```

- [ ] **Step 2: Add `/api/send/stop` tests**

Add to `test/api.test.js` (after the test from Step 1):

```js
test('POST /api/send/stop stops a running job', async () => {
  const { app: a, store: s, sender } = buildAppWith(async () => ({ ok: true, durationMs: 1 }));
  await s.write('accounts', [
    { login: 'u1', oauthToken: 'oauth:' + 'x'.repeat(30) },
    { login: 'u2', oauthToken: 'oauth:' + 'y'.repeat(30) }
  ]);
  await s.write('settings', { channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: 60, concurrency: 1 });
  const start = await request(a).post('/api/send').send({}).expect(202);
  const r = await request(a).post('/api/send/stop').send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.stopped, true);
  assert.equal(r.body.jobId, start.body.jobId);
  assert.equal(sender.isRunning(), false);
});

test('POST /api/send/stop 409 when nothing is running', async () => {
  const { app: a } = buildAppWith(async () => ({ ok: true, durationMs: 1 }));
  const r = await request(a).post('/api/send/stop').send({});
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'not_running');
});

test('POST /api/send/stop 409 on second stop (already stopped)', async () => {
  const { app: a, store: s } = buildAppWith(async () => ({ ok: true, durationMs: 1 }));
  await s.write('accounts', [
    { login: 'u1', oauthToken: 'oauth:' + 'x'.repeat(30) },
    { login: 'u2', oauthToken: 'oauth:' + 'y'.repeat(30) }
  ]);
  await s.write('settings', { channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: 60, concurrency: 1 });
  await request(a).post('/api/send').send({}).expect(202);
  await request(a).post('/api/send/stop').send({}).expect(200);
  const r = await request(a).post('/api/send/stop').send({});
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'not_running');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — quick-send no longer 409 (route still returns 409 / blocks); `/api/send/stop` returns 404 (route undefined).

- [ ] **Step 4: Update the `quick-send` handler**

In `routes/api.js`, replace the `r.post('/quick-send', ...)` handler (lines 73–90) with:

```js
  r.post('/quick-send', async (req, res) => {
    if (sender.isRunning()) sender.stop(sender.lastJobId());
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
    const result = await sendOneFn(accounts[idx], proxy, settings.channel, message);
    res.json({ ...result, proxy: proxyLabel });
  });
```

- [ ] **Step 5: Add the `/send/stop` route**

In `routes/api.js`, add immediately after the `r.post('/send/retry-failed', ...)` handler (after current line 125):

```js
  r.post('/send/stop', (req, res) => {
    const id = sender.lastJobId();
    const ok = id ? sender.stop(id) : false;
    if (ok) return res.json({ stopped: true, jobId: id });
    return res.status(409).json({ error: 'not_running' });
  });
```

- [ ] **Step 6: Make progress-replay handle the terminal `stopped` status**

In `routes/api.js`, in the `r.get('/progress', ...)` handler, replace the replay block (current lines 145–155):

```js
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
```

with:

```js
    const snapshot = sender.getSnapshot(jobId);
    if (snapshot) {
      for (const r of snapshot.results) {
        res.write(`event: progress\ndata: ${JSON.stringify({ login: r.login, proxy: r.proxy, result: { ok: r.ok, error: r.error, durationMs: r.durationMs, stopped: r.stopped } })}\n\n`);
      }
      if (snapshot.status !== 'running') {
        const ok = snapshot.results.filter(r => r.ok).length;
        const stopped = snapshot.results.filter(r => r.stopped).length;
        const total = snapshot.results.length;
        res.write(`event: done\ndata: ${JSON.stringify({ jobId, summary: { total, ok, failed: total - ok - stopped, stopped } })}\n\n`);
        return res.end();
      }
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all api tests green (including the rewritten quick-send test and three stop tests), all sender tests still green.

- [ ] **Step 8: Commit**

```bash
git add routes/api.js test/api.test.js
git commit -m "feat(api): quick-send stops bulk + POST /api/send/stop"
```

---

## Task 4: Frontend types (`api.ts`)

No frontend unit tests exist; verification is `npm run build` (TypeScript compile) at the end of the frontend tasks. This task only widens types so later tasks compile.

**Files:**
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Widen `SendResult`, `JobEvent` summary; add `StopResponse`**

In `frontend/src/lib/api.ts`, replace the `SendResult` type (lines 18–22):

```ts
export type SendResult = {
  ok: boolean;
  error?: string;
  durationMs: number;
};
```

with:

```ts
export type SendResult = {
  ok: boolean;
  error?: string;
  durationMs: number;
  stopped?: boolean;
};
```

Then replace the `done` member of the `JobEvent` union (line 30):

```ts
  | { type: 'done'; jobId: string; summary: { total: number; ok: number; failed: number } };
```

with:

```ts
  | { type: 'done'; jobId: string; summary: { total: number; ok: number; failed: number; stopped: number } };
```

And add, right after the `QuickSendResponse` type (after line 32):

```ts
export type StopResponse = { stopped: true; jobId: string };
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat(spa): types for stopped result + StopResponse"
```

---

## Task 5: Frontend UI — Stop button, stopped state, always-on Quick send

**Files:**
- Modify: `frontend/src/lib/error-labels.ts`
- Modify: `frontend/src/components/ProgressTable.tsx`
- Modify: `frontend/src/components/JobStats.tsx`
- Modify: `frontend/src/components/QuickSend.tsx`
- Modify: `frontend/src/pages/MainPage.tsx`

- [ ] **Step 1: Add error labels**

In `frontend/src/lib/error-labels.ts`, add two entries inside `ERROR_LABELS` (after the `no_channel` line, before the closing `}`):

```ts
  no_channel: 'В Settings не задан канал',
  stopped: 'Остановлен',
  not_running: 'Рассылка не идёт'
```

(Replace the existing `no_channel: 'В Settings не задан канал'` line — which currently has no trailing comma — with the three lines above.)

- [ ] **Step 2: Render the `stopped` row kind in ProgressTable**

In `frontend/src/components/ProgressTable.tsx`, replace the `ProgressRow` `kind` field (line 10):

```ts
  kind?: 'ok' | 'err' | 'in-progress';
```

with:

```ts
  kind?: 'ok' | 'err' | 'in-progress' | 'stopped';
```

Then in `statusBadge`, add a branch before the final `return` (after line 18, the `in-progress` line):

```ts
  if (r.kind === 'stopped') return <Badge variant="outline" className="text-muted-foreground">{r.status}</Badge>;
```

- [ ] **Step 3: Show the `stopped` counter in JobStats**

In `frontend/src/components/JobStats.tsx`, add `stopped` to `Props` (after `failed: number;`, line 9):

```ts
  stopped: number;
```

Update the destructure (line 12):

```ts
export function JobStats({ elapsedSec, etaSec, pending, sending, ok, failed, stopped }: Props) {
```

And add a stat cell after the `Failed` div (after line 20):

```tsx
      <div className="text-muted-foreground">Stopped: <strong>{stopped}</strong></div>
```

- [ ] **Step 4: Remove the "wait for bulk" disabled text in QuickSend**

In `frontend/src/components/QuickSend.tsx`, replace the status line (line 85):

```tsx
          {disabled ? 'Жди завершения bulk-send' : status.text}
```

with:

```tsx
          {status.text}
```

(The `disabled` prop still controls field/button disabling during the quick-send request itself; it is simply no longer driven by bulk state — see MainPage change.)

- [ ] **Step 5: MainPage — derive `stopped`, always-enable QuickSend, add Stop button**

In `frontend/src/pages/MainPage.tsx`, make these edits:

**(a)** In `deriveRows`, update the counts object initializer (line 47):

```ts
  const counts = { pending: 0, sending: 0, ok: 0, failed: 0, stopped: 0 };
```

**(b)** In `deriveRows`, handle the `stopped` result in the `progress` branch. Replace lines 36–41:

```ts
    } else if (e.type === 'progress') {
      const r = map[e.login] || (map[e.login] = { login: e.login, status: 'pending', proxy: '—', durationMs: null, error: '' });
      r.proxy = e.proxy;
      r.durationMs = e.result.durationMs;
      if (e.result.ok) { r.status = 'ok'; r.kind = 'ok'; r.error = ''; }
      else { r.status = 'failed'; r.kind = 'err'; r.error = errLabel(e.result.error); }
    } else if (e.type === 'done') {
```

with:

```ts
    } else if (e.type === 'progress') {
      const r = map[e.login] || (map[e.login] = { login: e.login, status: 'pending', proxy: '—', durationMs: null, error: '' });
      r.proxy = e.proxy;
      r.durationMs = e.result.durationMs ?? null;
      if (e.result.stopped) { r.status = 'остановлен'; r.kind = 'stopped'; r.error = ''; }
      else if (e.result.ok) { r.status = 'ok'; r.kind = 'ok'; r.error = ''; }
      else { r.status = 'failed'; r.kind = 'err'; r.error = errLabel(e.result.error); }
    } else if (e.type === 'done') {
```

**(c)** In `deriveRows`, count the `stopped` kind. Replace the counts loop (lines 48–53):

```ts
  for (const r of rows) {
    if (r.kind === 'ok') counts.ok++;
    else if (r.kind === 'err') counts.failed++;
    else if (r.kind === 'in-progress') counts.sending++;
    else counts.pending++;
  }
```

with:

```ts
  for (const r of rows) {
    if (r.kind === 'ok') counts.ok++;
    else if (r.kind === 'err') counts.failed++;
    else if (r.kind === 'stopped') counts.stopped++;
    else if (r.kind === 'in-progress') counts.sending++;
    else counts.pending++;
  }
```

**(d)** In the new-events effect, log the `stopped` progress event distinctly. Replace lines 107–113 (the `progress` branch):

```ts
      } else if (ev.type === 'progress') {
        dispatchLog({
          type: 'add',
          entry: ev.result.ok
            ? { login: ev.login, text: `успех (${ev.result.durationMs}ms)`, kind: 'ok' }
            : { login: ev.login, text: 'ошибка: ' + errLabel(ev.result.error), kind: 'err' }
        });
      } else if (ev.type === 'done') {
```

with:

```ts
      } else if (ev.type === 'progress') {
        dispatchLog({
          type: 'add',
          entry: ev.result.stopped
            ? { login: ev.login, text: 'остановлен' }
            : ev.result.ok
              ? { login: ev.login, text: `успех (${ev.result.durationMs}ms)`, kind: 'ok' }
              : { login: ev.login, text: 'ошибка: ' + errLabel(ev.result.error), kind: 'err' }
        });
      } else if (ev.type === 'done') {
```

**(e)** Update the `done` log line to include stopped. Replace line 115:

```ts
        dispatchLog({ type: 'add', entry: { text: `завершено: ${ev.summary.ok}/${ev.summary.total} успешно, ${ev.summary.failed} с ошибкой`, kind: ev.summary.failed === 0 ? 'ok' : 'err' } });
```

with:

```ts
        dispatchLog({ type: 'add', entry: { text: `завершено: ${ev.summary.ok}/${ev.summary.total} успешно, ${ev.summary.failed} с ошибкой, ${ev.summary.stopped} остановлено`, kind: ev.summary.failed === 0 ? 'ok' : 'err' } });
```

**(f)** Add a `stopJob` handler. Insert right after the `startJob` function (after line 152, before `return (`):

```ts
  async function stopJob() {
    const res = await api.request<import('@/lib/api').StopResponse>('POST', '/api/send/stop');
    if (res.ok) {
      dispatchLog({ type: 'add', entry: { text: 'остановлено вручную' } });
    } else if (!res.ok && res.err.status !== 409) {
      toast.error(errLabel(res.err.error) || `HTTP ${res.err.status}`);
    }
    // 409 not_running: job already finished — ignore silently
  }
```

**(g)** Make QuickSend always enabled. Replace lines 156–159:

```tsx
      <QuickSend
        disabled={isRunning}
        onLogEvent={(e) => dispatchLog({ type: 'add', entry: e })}
      />
```

with:

```tsx
      <QuickSend
        disabled={false}
        onLogEvent={(e) => dispatchLog({ type: 'add', entry: e })}
      />
```

**(h)** Add the Stop button next to Send. Replace the buttons block (lines 172–184):

```tsx
      <div className="flex gap-2">
        <Button
          onClick={async () => {
            if (await confirmDeadProxies()) startJob('/api/send');
          }}
          disabled={isRunning}
        >
          Send
        </Button>
        {doneSummary && doneSummary.failed > 0 && (
          <Button variant="secondary" onClick={() => startJob('/api/send/retry-failed')} disabled={isRunning}>Retry failed</Button>
        )}
      </div>
```

with:

```tsx
      <div className="flex gap-2">
        <Button
          onClick={async () => {
            if (await confirmDeadProxies()) startJob('/api/send');
          }}
          disabled={isRunning}
        >
          Send
        </Button>
        {isRunning && (
          <Button variant="destructive" onClick={stopJob}>Stop</Button>
        )}
        {doneSummary && doneSummary.failed > 0 && (
          <Button variant="secondary" onClick={() => startJob('/api/send/retry-failed')} disabled={isRunning}>Retry failed</Button>
        )}
      </div>
```

**(i)** Pass `stopped` to JobStats. Replace line 186:

```tsx
        <JobStats elapsedSec={elapsed} etaSec={etaSec} pending={counts.pending} sending={counts.sending} ok={counts.ok} failed={counts.failed} />
```

with:

```tsx
        <JobStats elapsedSec={elapsed} etaSec={etaSec} pending={counts.pending} sending={counts.sending} ok={counts.ok} failed={counts.failed} stopped={counts.stopped} />
```

- [ ] **Step 6: Verify the frontend compiles**

Run: `npm run build`
Expected: build succeeds with no TypeScript errors; `dist/` is regenerated.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/error-labels.ts frontend/src/components/ProgressTable.tsx frontend/src/components/JobStats.tsx frontend/src/components/QuickSend.tsx frontend/src/pages/MainPage.tsx
git commit -m "feat(spa): Stop button, stopped row state, always-on Quick send"
```

(`dist/` is gitignored — the build output is not committed; the `npm run build` step only verifies the TypeScript compiles.)

---

## Task 6: Docs + full verification

**Files:**
- Modify: `docs/next-steps.md`

- [ ] **Step 1: Add a manual smoke-test note**

Append to `docs/next-steps.md`:

```markdown
## Smoke test: stop bulk + shuffle order

- With ≥3 accounts and `spreadSeconds` > 0, click **Send**. Confirm accounts go out in a *different* order across two runs (random).
- Mid-run, click **Stop**: remaining accounts show a neutral "остановлен" badge; the job finishes with a `stopped` count in JobStats; the page unblocks.
- Mid-run, instead use **Quick send** for one account: bulk stops automatically and the direct message goes out.
- Each account always uses the same proxy regardless of run order (check the Proxy column).
```

- [ ] **Step 2: Run the full backend test suite**

Run: `npm test`
Expected: PASS — all suites green. This adds 6 sender tests (3 × shuffle, 1 × order, 2 × stop) and a net +3 api tests (replaced the old `quick-send 409` test with an auto-stop test; added 3 `/send/stop` tests). Confirm zero failures.

- [ ] **Step 3: Build the frontend once more**

Run: `npm run build`
Expected: clean build, no TS errors.

- [ ] **Step 4: Commit**

```bash
git add docs/next-steps.md
git commit -m "docs: smoke-test steps for stop-bulk + shuffle"
```

---

## Self-Review Notes

- **Spec §3.1–3.5 (interruptibility):** Task 2 (`stop()`, in-flight finish, `stopped` status/summary), Task 3 (quick-send auto-stop, `/send/stop`, terminal replay), Task 5 (Stop button, stopped UI).
- **Spec §3.6–3.7 (random order, always on):** Task 1 (`shuffle`), Task 2 (order with proxy bound to original index, no settings toggle).
- **Spec §5.1 (`markStopped` idempotency, `pendingTasks`):** Task 2 implements the exact helper and guard.
- **Spec §5.2 (API):** Task 3.
- **Spec §6 (frontend):** Tasks 4–5.
- **Spec §7 (tests):** Tasks 1–3 backend tests; frontend "no unit tests" honored (build-only verification).
- **Spec §8 (out of scope):** No AbortController, no settings toggle, `assignProxy` unchanged — respected.
- **Type consistency:** `summary.stopped` (number) added in sender (Task 2), api replay (Task 3), api.ts type (Task 4), JobStats/MainPage (Task 5). `result.stopped` (boolean) consistent across sender emit, api.ts `SendResult`, ProgressTable/MainPage. `stop(jobId)` signature identical in sender, api.js, tests.
- **Behavior change covered:** old `quick-send 409` test is explicitly replaced (Task 3 Step 1), not left dangling.
