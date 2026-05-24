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

import { validateAccounts, validateProxies, validateSettings } from '../store.js';

test('validateAccounts: empty array is valid', () => {
  assert.deepEqual(validateAccounts([]), []);
});

test('validateAccounts: rejects missing login', () => {
  const errors = validateAccounts([{ oauthToken: 'oauth:abcdefghijklmnopqrstuvwxyz1234' }]);
  assert.ok(errors[0].includes('login'));
});

test('validateAccounts: rejects bad token prefix', () => {
  const errors = validateAccounts([{ login: 'a', oauthToken: 'wrong' }]);
  assert.ok(errors[0].includes('oauth:'));
});

test('validateAccounts: accepts valid entry', () => {
  assert.deepEqual(validateAccounts([{ login: 'a_b1', oauthToken: 'oauth:' + 'x'.repeat(30) }]), []);
});

test('validateProxies: rejects invalid port', () => {
  const errors = validateProxies([{ host: 'h', port: 99999 }]);
  assert.ok(errors[0].includes('port'));
});

test('validateProxies: accepts host:port only', () => {
  assert.deepEqual(validateProxies([{ host: '1.2.3.4', port: 1080 }]), []);
});

test('validateSettings: rejects negative spread', () => {
  const errors = validateSettings({ channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: -1, concurrency: 5 });
  assert.ok(errors.some(e => e.includes('spreadSeconds')));
});

test('validateSettings: rejects concurrency 0', () => {
  const errors = validateSettings({ channel: 'c', word: 'w', accountsPerProxy: 5, spreadSeconds: 0, concurrency: 0 });
  assert.ok(errors.some(e => e.includes('concurrency')));
});
