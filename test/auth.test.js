import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signCookie, verifyCookie } from '../auth.js';

const SECRET = 'a'.repeat(64);

test('signCookie produces verifiable token', () => {
  const token = signCookie({ ts: 1000 }, SECRET);
  const result = verifyCookie(token, SECRET);
  assert.equal(result.ts, 1000);
});

test('verifyCookie returns null on tampered payload', () => {
  const token = signCookie({ ts: 1000 }, SECRET);
  const tampered = token.replace('1000', '9999');
  assert.equal(verifyCookie(tampered, SECRET), null);
});

test('verifyCookie returns null on wrong secret', () => {
  const token = signCookie({ ts: 1000 }, SECRET);
  assert.equal(verifyCookie(token, 'b'.repeat(64)), null);
});

test('verifyCookie returns null on malformed input', () => {
  assert.equal(verifyCookie('garbage', SECRET), null);
  assert.equal(verifyCookie('', SECRET), null);
  assert.equal(verifyCookie(null, SECRET), null);
});
