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

test('createSender: forwards stage events from sendOne', async () => {
  const login = 'stageuser';
  const sendOne = async (_account, _proxy, _channel, _word, opts) => {
    opts.onStage('connecting');
    opts.onStage('sent');
    return { ok: true, durationMs: 1 };
  };
  const sender = createSender({ sendOne });
  const events = [];
  const accounts = [{ login, oauthToken: 'oauth:x' }];
  const { jobId } = sender.start({ accounts, proxies: [], settings });
  sender.subscribe(jobId, (e) => events.push(e));
  await new Promise(r => setTimeout(r, 50));
  const stageEvents = events.filter(e => e.type === 'stage');
  assert.equal(stageEvents.length, 2);
  assert.deepEqual(stageEvents[0], { type: 'stage', login, stage: 'connecting' });
  assert.deepEqual(stageEvents[1], { type: 'stage', login, stage: 'sent' });
});

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
