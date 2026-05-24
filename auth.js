import crypto from 'node:crypto';
import bcrypt from 'bcrypt';

export async function verifyPassword(plain, hash) {
  if (!hash || typeof hash !== 'string') return false;
  try { return await bcrypt.compare(plain, hash); }
  catch { return false; }
}

export function signCookie(payload, secret) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyCookie(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const lastDot = token.lastIndexOf('.');
  const body = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export const COOKIE_NAME = 'tms_sid';

export function makeMiddleware({ secret, cookieMaxAgeMs }) {
  return function authMw(req, res, next) {
    const raw = req.cookies?.[COOKIE_NAME];
    const payload = raw ? verifyCookie(raw, secret) : null;
    const fresh = payload && (Date.now() - payload.ts) < cookieMaxAgeMs;
    if (fresh) return next();
    const wantsJson = (req.path || '').startsWith('/api/') ||
                       (req.headers?.accept || '').includes('application/json');
    if (wantsJson) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect('/login');
  };
}

export function buildCookie(secret) {
  return signCookie({ ts: Date.now() }, secret);
}
