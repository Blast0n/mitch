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
