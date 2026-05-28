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
  // Eagerly start the first request via .end() so the server receives it
  // before we poll for the lock. (superagent defers sending until .then();
  // calling .end() bypasses that deferral.)
  const firstPromise = new Promise((resolve, reject) => {
    request(app).post('/api/proxies/check').send({}).end((err, res) => {
      if (err) reject(err); else resolve(res);
    });
  });
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
