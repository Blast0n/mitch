export const keyOf = (p) =>
  `${p.host}:${p.port}|${p.username ?? ''}|${p.password ?? ''}`;

export function createHealthStore() {
  const map = new Map();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, entry) => { map.set(key, entry); },
    getAll: () => Array.from(map.entries()).map(([key, entry]) => ({ key, ...entry })),
    getEntriesFor: (proxies) =>
      proxies.map(p => ({ key: keyOf(p), entry: map.get(keyOf(p)) ?? null })),
    getDeadCount: (proxies) =>
      proxies.filter(p => map.get(keyOf(p))?.ok === false).length
  };
}
