export const buildPass = (token) => `PASS ${token}`;
export const buildNick = (login) => `NICK ${login.toLowerCase()}`;
export const buildJoin = (channel) => `JOIN #${channel.toLowerCase()}`;
export const buildPrivmsg = (channel, msg) => `PRIVMSG #${channel.toLowerCase()} :${msg}`;

export function parseLine(line) {
  let i = 0, prefix = null;
  if (line[0] === ':') {
    const space = line.indexOf(' ');
    prefix = line.slice(1, space);
    i = space + 1;
  }
  const parts = [];
  while (i < line.length) {
    if (line[i] === ':') { parts.push(line.slice(i + 1)); break; }
    const next = line.indexOf(' ', i);
    if (next === -1) { parts.push(line.slice(i)); break; }
    parts.push(line.slice(i, next));
    i = next + 1;
  }
  return { prefix, command: parts[0], params: parts.slice(1) };
}

export const isPing = (msg) => msg.command === 'PING';


const NEGATIVE_NOTICE_MARKERS = [
  'login authentication failed',
  'invalid nick',
  'improperly formatted auth'
];

export function isAuthFailNotice(msg) {
  if (msg.command !== 'NOTICE') return false;
  const text = (msg.params[msg.params.length - 1] || '').toLowerCase();
  return NEGATIVE_NOTICE_MARKERS.some(m => text.includes(m));
}

const POST_JOIN_ERROR_MARKERS = [
  'banned from talking',
  'you don\'t have permission',
  'msg_banned',
  'msg_timedout',
  'you are sending messages too quickly',
  'this channel has been suspended',
  'no chatting in this channel'
];

export function isPostJoinErrorNotice(msg) {
  if (msg.command !== 'NOTICE') return false;
  const text = (msg.params[msg.params.length - 1] || '').toLowerCase();
  return POST_JOIN_ERROR_MARKERS.some(m => text.includes(m));
}

import WebSocket from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';

const TWITCH_WSS = 'wss://irc-ws.chat.twitch.tv:443';

// Default production transport. Opens a real WebSocket.
const defaultTransport = {
  connect(proxy) {
    const opts = {};
    if (proxy) {
      const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@` : '';
      opts.agent = new SocksProxyAgent(`socks5://${auth}${proxy.host}:${proxy.port}`);
    }
    const ws = new WebSocket(TWITCH_WSS, opts);
    return {
      on(ev, fn) {
        if (ev === 'open') ws.on('open', fn);
        else if (ev === 'message') ws.on('message', (data) => fn({ data: data.toString() }));
        else if (ev === 'close') ws.on('close', fn);
        else if (ev === 'error') ws.on('error', fn);
      },
      send: (line) => ws.send(line + '\r\n'),
      close: () => { try { ws.terminate(); } catch {} }
    };
  }
};

export async function sendOne(account, proxy, channel, word, opts = {}) {
  const transport = opts.transport ?? defaultTransport;
  const postSendWaitMs = opts.postSendWaitMs ?? 3000;
  const overallTimeoutMs = opts.overallTimeoutMs ?? 15000;
  const start = Date.now();
  let conn;
  let settled = false;

  return new Promise((resolve) => {
    let overall;
    let postSendTimer = null;
    let privmsgSent = false;

    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { conn?.close(); } catch {}
      clearTimeout(overall);
      clearTimeout(postSendTimer);
      resolve({ ...r, durationMs: Date.now() - start });
    };

    overall = setTimeout(() => finish({ ok: false, error: 'timeout' }), overallTimeoutMs);

    try {
      conn = transport.connect(proxy);
    } catch (err) {
      return finish({ ok: false, error: 'proxy_unreachable', details: err.message });
    }

    conn.on('open', () => {
      try {
        conn.send(buildPass(account.oauthToken));
        conn.send(buildNick(account.login));
        conn.send(buildJoin(channel));
        conn.send(buildPrivmsg(channel, word));
        privmsgSent = true;
        postSendTimer = setTimeout(() => finish({ ok: true }), postSendWaitMs);
      } catch (err) {
        finish({ ok: false, error: 'unknown', details: err.message });
      }
    });

    conn.on('message', (ev) => {
      const lines = String(ev.data).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const msg = parseLine(line);
        if (isPing(msg)) {
          conn.send('PONG :' + (msg.params[0] || 'tmi.twitch.tv'));
          continue;
        }
        if (isAuthFailNotice(msg)) {
          return finish({ ok: false, error: 'token_invalid' });
        }
        if (privmsgSent && isPostJoinErrorNotice(msg)) {
          return finish({ ok: false, error: 'chat_blocked', details: msg.params[msg.params.length - 1] });
        }
      }
    });

    conn.on('error', (err) => finish({ ok: false, error: 'twitch_unreachable', details: err?.message }));
    conn.on('close', () => {
      if (!privmsgSent) finish({ ok: false, error: 'twitch_unreachable' });
    });
  });
}
