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
