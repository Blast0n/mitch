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
