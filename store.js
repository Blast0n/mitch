import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = {
  accounts: [],
  proxies: [],
  settings: {
    channel: '',
    word: '',
    accountsPerProxy: 5,
    spreadSeconds: 0,
    concurrency: 5
  }
};

export class Store {
  constructor(dir) { this.dir = dir; }

  async read(name) {
    const file = path.join(this.dir, `${name}.json`);
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return structuredClone(DEFAULTS[name]);
      if (err instanceof SyntaxError) {
        const e = new Error(`Corrupt JSON in ${name}.json: ${err.message}`);
        e.code = 'STORE_CORRUPT';
        throw e;
      }
      throw err;
    }
  }

  async write(name, data) {
    const file = path.join(this.dir, `${name}.json`);
    const tmp = file + '.tmp';
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  }
}

const LOGIN_RE = /^[a-zA-Z0-9_]+$/;

export function validateAccounts(arr) {
  const errors = [];
  if (!Array.isArray(arr)) return ['accounts: must be array'];
  arr.forEach((a, i) => {
    if (!a || typeof a !== 'object') errors.push(`row ${i + 1}: not an object`);
    else {
      if (typeof a.login !== 'string' || !LOGIN_RE.test(a.login)) errors.push(`row ${i + 1}: invalid login`);
      if (typeof a.oauthToken !== 'string' || !a.oauthToken.startsWith('oauth:') || a.oauthToken.length < 30) {
        errors.push(`row ${i + 1}: oauthToken must start with 'oauth:' and be ≥30 chars`);
      }
    }
  });
  return errors;
}

export function validateProxies(arr) {
  const errors = [];
  if (!Array.isArray(arr)) return ['proxies: must be array'];
  arr.forEach((p, i) => {
    if (!p || typeof p !== 'object') errors.push(`row ${i + 1}: not an object`);
    else {
      if (typeof p.host !== 'string' || !p.host) errors.push(`row ${i + 1}: empty host`);
      if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) errors.push(`row ${i + 1}: invalid port`);
      if (p.username != null && typeof p.username !== 'string') errors.push(`row ${i + 1}: username must be string`);
      if (p.password != null && typeof p.password !== 'string') errors.push(`row ${i + 1}: password must be string`);
    }
  });
  return errors;
}

export function validateSettings(s) {
  const errors = [];
  if (!s || typeof s !== 'object') return ['settings: must be object'];
  if (typeof s.channel !== 'string') errors.push('channel: must be string');
  if (typeof s.word !== 'string') errors.push('word: must be string');
  if (!Number.isInteger(s.accountsPerProxy) || s.accountsPerProxy < 1) errors.push('accountsPerProxy: must be positive int');
  if (!Number.isFinite(s.spreadSeconds) || s.spreadSeconds < 0) errors.push('spreadSeconds: must be ≥0');
  if (!Number.isInteger(s.concurrency) || s.concurrency < 1) errors.push('concurrency: must be positive int');
  return errors;
}
