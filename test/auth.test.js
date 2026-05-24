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

import { makeMiddleware, COOKIE_NAME } from '../auth.js';

function mockReq(cookieValue) {
  return { cookies: cookieValue ? { [COOKIE_NAME]: cookieValue } : {}, headers: {} };
}
function mockRes() {
  let status, redirectTo, body;
  return {
    redirect: (u) => { redirectTo = u; },
    status: (s) => ({ json: (b) => { status = s; body = b; } }),
    _get: () => ({ status, redirectTo, body })
  };
}

test('middleware: redirects html request without cookie', () => {
  const mw = makeMiddleware({ secret: SECRET, cookieMaxAgeMs: 1000 });
  const req = mockReq();
  req.headers.accept = 'text/html';
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._get().redirectTo, '/login');
});

test('middleware: 401 JSON for api request without cookie', () => {
  const mw = makeMiddleware({ secret: SECRET, cookieMaxAgeMs: 1000 });
  const req = { cookies: {}, headers: { accept: 'application/json' }, path: '/api/x' };
  const res = mockRes();
  mw(req, res, () => {});
  assert.equal(res._get().status, 401);
});

test('middleware: passes with valid fresh cookie', () => {
  const mw = makeMiddleware({ secret: SECRET, cookieMaxAgeMs: 60_000 });
  const cookie = signCookie({ ts: Date.now() }, SECRET);
  const req = mockReq(cookie);
  req.headers.accept = 'text/html';
  let nextCalled = false;
  mw(req, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('middleware: rejects expired cookie', () => {
  const mw = makeMiddleware({ secret: SECRET, cookieMaxAgeMs: 1000 });
  const cookie = signCookie({ ts: Date.now() - 10_000 }, SECRET);
  const req = mockReq(cookie);
  req.headers.accept = 'text/html';
  const res = mockRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._get().redirectTo, '/login');
});
