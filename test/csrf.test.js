import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCsrfMiddleware } from '../csrf.js';

function res() {
  let body, status;
  return { status: (s) => ({ json: (b) => { status = s; body = b; } }), _get: () => ({ status, body }) };
}

test('csrf: GET passes without origin', () => {
  const mw = makeCsrfMiddleware({ expectedOrigin: 'https://example.com' });
  let next = false;
  mw({ method: 'GET', headers: {} }, res(), () => next = true);
  assert.equal(next, true);
});

test('csrf: POST with matching origin passes', () => {
  const mw = makeCsrfMiddleware({ expectedOrigin: 'https://example.com' });
  let next = false;
  mw({ method: 'POST', headers: { origin: 'https://example.com' } }, res(), () => next = true);
  assert.equal(next, true);
});

test('csrf: POST with mismatched origin 403s', () => {
  const mw = makeCsrfMiddleware({ expectedOrigin: 'https://example.com' });
  const r = res();
  mw({ method: 'POST', headers: { origin: 'https://evil.com' } }, r, () => {});
  assert.equal(r._get().status, 403);
});

test('csrf: POST without origin or referer 403s', () => {
  const mw = makeCsrfMiddleware({ expectedOrigin: 'https://example.com' });
  const r = res();
  mw({ method: 'POST', headers: {} }, r, () => {});
  assert.equal(r._get().status, 403);
});

test('csrf: falls back to referer host check', () => {
  const mw = makeCsrfMiddleware({ expectedOrigin: 'https://example.com' });
  let next = false;
  mw({ method: 'PUT', headers: { referer: 'https://example.com/page' } }, res(), () => next = true);
  assert.equal(next, true);
});
