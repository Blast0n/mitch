import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

// Helper to build a configured app with a real twitch.sendOne replacement
function buildAppWith(sendOneImpl) {
  const s = new Store(dir);
  const sender = createSender({ sendOne: sendOneImpl });
  const a = express();
  a.use(express.json());
  a.use('/api', apiRouter({ store: s, sender, sendOne: sendOneImpl }));
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
