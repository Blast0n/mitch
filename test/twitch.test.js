import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPass, buildNick, buildJoin, buildPrivmsg, parseLine, isPing, isAuthFailNotice, isPostJoinErrorNotice } from '../twitch.js';

test('build commands', () => {
  assert.equal(buildPass('oauth:abc'), 'PASS oauth:abc');
  assert.equal(buildNick('USER'), 'NICK user');
  assert.equal(buildJoin('Chan'), 'JOIN #chan');
  assert.equal(buildPrivmsg('Chan', 'hi'), 'PRIVMSG #chan :hi');
});

test('parseLine: simple PING', () => {
  const p = parseLine('PING :tmi.twitch.tv');
  assert.equal(p.command, 'PING');
  assert.deepEqual(p.params, ['tmi.twitch.tv']);
});

test('parseLine: with prefix and trailing', () => {
  const p = parseLine(':tmi.twitch.tv NOTICE * :Login authentication failed');
  assert.equal(p.prefix, 'tmi.twitch.tv');
  assert.equal(p.command, 'NOTICE');
  assert.deepEqual(p.params, ['*', 'Login authentication failed']);
});

test('isPing', () => {
  assert.equal(isPing(parseLine('PING :tmi.twitch.tv')), true);
  assert.equal(isPing(parseLine('PRIVMSG #x :hi')), false);
});

test('isAuthFailNotice', () => {
  const ok = parseLine(':tmi.twitch.tv NOTICE * :Login authentication failed');
  const other = parseLine(':tmi.twitch.tv NOTICE #x :something else');
  assert.equal(isAuthFailNotice(ok), true);
  assert.equal(isAuthFailNotice(other), false);
});

test('isPostJoinErrorNotice', () => {
  const banned = parseLine(':tmi.twitch.tv NOTICE #x :You are permanently banned from talking in x.');
  const ok = parseLine(':tmi.twitch.tv NOTICE #x :This room is in r9k mode.');
  assert.equal(isPostJoinErrorNotice(banned), true);
  assert.equal(isPostJoinErrorNotice(ok), false);
});

import { sendOne } from '../twitch.js';

// fakeTransport: array of script entries [{type:'expect', re:RegExp}|{type:'send', line:string}]
// drives a fake WebSocket-like object.
function fakeTransport(script) {
  let i = 0;
  const handlers = { message: [], open: [], close: [], error: [] };
  const sent = [];
  function step() {
    while (i < script.length && script[i].type === 'send') {
      const line = script[i++].line;
      queueMicrotask(() => handlers.message.forEach(h => h({ data: line + '\r\n' })));
    }
  }
  return {
    connect: () => {
      queueMicrotask(() => handlers.open.forEach(h => h()));
      step();
      return {
        on: (ev, fn) => { handlers[ev].push(fn); if (ev === 'open') step(); },
        send: (data) => {
          const trimmed = String(data).trim();
          sent.push(trimmed);
          if (i < script.length && script[i].type === 'expect') {
            if (!script[i].re.test(trimmed)) throw new Error(`unexpected: ${trimmed}`);
            i++;
            step();
          }
        },
        close: () => queueMicrotask(() => handlers.close.forEach(h => h()))
      };
    },
    sent
  };
}

test('sendOne: happy path', async () => {
  const t = fakeTransport([
    { type: 'expect', re: /^PASS / },
    { type: 'expect', re: /^NICK / },
    { type: 'expect', re: /^JOIN / },
    { type: 'expect', re: /^PRIVMSG / }
  ]);
  const result = await sendOne(
    { login: 'u', oauthToken: 'oauth:xxx' },
    null, 'chan', 'hello',
    { transport: t, postSendWaitMs: 50, overallTimeoutMs: 5000 }
  );
  assert.equal(result.ok, true);
  assert.ok(result.durationMs >= 0);
});

test('sendOne: token_invalid on auth fail NOTICE', async () => {
  const t = fakeTransport([
    { type: 'expect', re: /^PASS / },
    { type: 'expect', re: /^NICK / },
    { type: 'send', line: ':tmi.twitch.tv NOTICE * :Login authentication failed' }
  ]);
  const r = await sendOne(
    { login: 'u', oauthToken: 'oauth:bad' },
    null, 'chan', 'hi',
    { transport: t, postSendWaitMs: 50, overallTimeoutMs: 5000 }
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, 'token_invalid');
});

test('sendOne: chat_blocked on post-PRIVMSG NOTICE', async () => {
  const t = fakeTransport([
    { type: 'expect', re: /^PASS / },
    { type: 'expect', re: /^NICK / },
    { type: 'expect', re: /^JOIN / },
    { type: 'expect', re: /^PRIVMSG / },
    { type: 'send', line: ':tmi.twitch.tv NOTICE #chan :You are permanently banned from talking in chan.' }
  ]);
  const r = await sendOne(
    { login: 'u', oauthToken: 'oauth:xxx' },
    null, 'chan', 'hi',
    { transport: t, postSendWaitMs: 200, overallTimeoutMs: 5000 }
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, 'chat_blocked');
});

test('sendOne: PING/PONG handled during post-send wait', async () => {
  // Real Twitch sends PING any time. Our impl sends PASS/NICK/JOIN/PRIVMSG
  // back-to-back in `open`, then waits postSendWaitMs. PING arriving during
  // that wait must be answered with PONG.
  const t = fakeTransport([
    { type: 'expect', re: /^PASS / },
    { type: 'expect', re: /^NICK / },
    { type: 'expect', re: /^JOIN / },
    { type: 'expect', re: /^PRIVMSG / },
    { type: 'send', line: 'PING :tmi.twitch.tv' },
    { type: 'expect', re: /^PONG / }
  ]);
  const r = await sendOne(
    { login: 'u', oauthToken: 'oauth:xxx' },
    null, 'chan', 'hi',
    { transport: t, postSendWaitMs: 80, overallTimeoutMs: 5000 }
  );
  assert.equal(r.ok, true);
});

test('sendOne: onStage captures all stages in order', async () => {
  const t = fakeTransport([
    { type: 'expect', re: /^PASS / },
    { type: 'expect', re: /^NICK / },
    { type: 'expect', re: /^JOIN / },
    { type: 'expect', re: /^PRIVMSG / }
  ]);
  const stages = [];
  const result = await sendOne(
    { login: 'u', oauthToken: 'oauth:xxx' },
    null, 'chan', 'hello',
    { transport: t, postSendWaitMs: 50, overallTimeoutMs: 5000, onStage: (s) => stages.push(s) }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(stages, ['connecting', 'auth', 'join', 'sent', 'waiting']);
});
