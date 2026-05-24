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
