export type Account = { login: string; oauthToken: string };

export type Proxy = {
  host: string;
  port: number;
  username?: string;
  password?: string;
};

export type Settings = {
  channel: string;
  word: string;
  accountsPerProxy: number;
  spreadSeconds: number;
  concurrency: number;
};

export type SendResult = {
  ok: boolean;
  error?: string;
  durationMs: number;
  stopped?: boolean;
};

export type Stage = 'connecting' | 'auth' | 'join' | 'sent' | 'waiting';

export type JobEvent =
  | { type: 'sending'; login: string; proxy: string }
  | { type: 'stage'; login: string; stage: Stage }
  | { type: 'progress'; login: string; proxy: string; result: SendResult }
  | { type: 'done'; jobId: string; summary: { total: number; ok: number; failed: number; stopped: number } };

export type QuickSendResponse = SendResult & { proxy: string };
export type StopResponse = { stopped: true; jobId: string };

export type ProxyHealthEntry = {
  key: string;
  ok: boolean;
  latencyMs: number;
  checkedAt: number;
  error?: string;
  details?: string;
};

export type ProxyHealthResponse = { entries: ProxyHealthEntry[] };

export type ProxyCheckResult = ProxyHealthEntry & { index: number };
export type ProxyCheckResponse = { results: ProxyCheckResult[] };

async function request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  if (res.status === 401) {
    window.location.href = '/login';
    return null;
  }
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

export type ApiError = { status: number; error?: string; raw?: unknown };

export async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; err: ApiError }> {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    if (res.status === 401) {
      window.location.href = '/login';
      return { ok: false, err: { status: 401 } };
    }
    if (res.status === 204) return { ok: true, data: null as T };
    const data = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data: data as T };
    return { ok: false, err: { status: res.status, error: data?.error, raw: data } };
  } catch (e) {
    return { ok: false, err: { status: 0, error: (e as Error).message } };
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  request: apiRequest
};
