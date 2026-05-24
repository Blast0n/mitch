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
