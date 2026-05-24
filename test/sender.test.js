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
