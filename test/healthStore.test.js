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
