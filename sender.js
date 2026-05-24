export function assignProxy(index, proxies, accountsPerProxy) {
  if (!proxies?.length) return null;
  const group = Math.floor(index / accountsPerProxy);
  return proxies[group % proxies.length];
}
