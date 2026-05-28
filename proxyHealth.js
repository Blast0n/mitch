import pLimit from 'p-limit';

const AUTH_FAIL_MARKERS = [
  'authentication failed',
  'authentication required'
];

const TWITCH_UNREACHABLE_MARKERS = [
  'host unreachable',
  'network unreachable',
  'connection not allowed',
  'connection refused by destination'
];

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'ENETUNREACH'
]);

export function classify(err) {
  if (!err) return 'unknown';
  const code = err.code;
  const msg = String(err.message || '').toLowerCase();
  if (UNREACHABLE_CODES.has(code)) return 'proxy_unreachable';
  if (AUTH_FAIL_MARKERS.some(m => msg.includes(m))) return 'proxy_auth_failed';
  if (TWITCH_UNREACHABLE_MARKERS.some(m => msg.includes(m))) return 'twitch_unreachable';
  return 'unknown';
}

export async function checkOne(proxy, opts = {}) {
  const transport = opts.transport;
  if (!transport) throw new Error('checkOne: opts.transport is required');
  const timeoutMs = opts.timeoutMs ?? 5000;
  const destination = opts.destination ?? { host: 'irc-ws.chat.twitch.tv', port: 443 };
  const start = Date.now();

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('timeout');
      e.code = 'CHECK_TIMEOUT';
      reject(e);
    }, timeoutMs);
  });

  try {
    const socket = await Promise.race([
      transport.connect({ proxy, destination, timeoutMs }),
      timeoutPromise
    ]);
    clearTimeout(timer);
    try { socket?.destroy?.(); } catch {}
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    clearTimeout(timer);
    const error = err?.code === 'CHECK_TIMEOUT' ? 'timeout' : classify(err);
    return { ok: false, error, details: err?.message ?? String(err), latencyMs: Date.now() - start };
  }
}

export async function checkMany(proxies, opts = {}) {
  const limit = pLimit(opts.concurrency ?? 8);
  return Promise.all(proxies.map(p => limit(() => checkOne(p, opts))));
}
