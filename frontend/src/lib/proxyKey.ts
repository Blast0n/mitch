import type { Proxy } from './api';

export const keyOf = (p: Pick<Proxy, 'host' | 'port' | 'username' | 'password'>): string =>
  `${p.host}:${p.port}|${p.username ?? ''}|${p.password ?? ''}`;
