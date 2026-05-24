import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';

export function assignProxy(index, proxies, accountsPerProxy) {
  if (!proxies?.length) return null;
  const group = Math.floor(index / accountsPerProxy);
  return proxies[group % proxies.length];
}

export function createSender({ sendOne }) {
  let currentJob = null;
  const listenersByJob = new Map();

  function emit(jobId, event) {
    const set = listenersByJob.get(jobId);
    if (!set) return;
    for (const fn of set) {
      try { fn(event); } catch {}
    }
  }

  function start({ accounts, proxies, settings }) {
    if (currentJob && currentJob.status === 'running') {
      throw new Error('JobAlreadyRunning: another job is running');
    }
    const jobId = randomUUID();
    const job = {
      jobId,
      status: 'running',
      results: [],
      settings,
      startedAt: Date.now()
    };
    currentJob = job;
    listenersByJob.set(jobId, new Set());

    const limit = pLimit(Math.max(1, settings.concurrency || 1));
    const interval = (settings.spreadSeconds * 1000) / Math.max(1, accounts.length);

    const tasks = accounts.map((account, i) => {
      const proxy = assignProxy(i, proxies, settings.accountsPerProxy);
      const proxyLabel = proxy ? `${proxy.host}:${proxy.port}` : 'direct';
      const delay = i * interval;
      return new Promise((resolve) => {
        setTimeout(() => {
          limit(async () => {
            emit(jobId, { type: 'sending', login: account.login, proxy: proxyLabel });
            const result = await sendOne(account, proxy, settings.channel, settings.word);
            const entry = { login: account.login, proxy: proxyLabel, ...result };
            job.results.push(entry);
            emit(jobId, { type: 'progress', login: account.login, proxy: proxyLabel, result });
          }).then(resolve, resolve);
        }, delay);
      });
    });

    Promise.all(tasks).then(() => {
      job.status = 'done';
      const ok = job.results.filter(r => r.ok).length;
      const summary = { total: accounts.length, ok, failed: accounts.length - ok };
      emit(jobId, { type: 'done', jobId, summary });
      setTimeout(() => {
        listenersByJob.delete(jobId);
        if (currentJob?.jobId === jobId) currentJob = null;
      }, 5 * 60 * 1000);
    });

    return { jobId };
  }

  function subscribe(jobId, listener) {
    const set = listenersByJob.get(jobId);
    if (!set) return () => {};
    set.add(listener);
    return () => set.delete(listener);
  }

  function getSnapshot(jobId) {
    if (!currentJob || currentJob.jobId !== jobId) return null;
    return {
      jobId,
      status: currentJob.status,
      results: [...currentJob.results]
    };
  }

  function getFailedLogins(jobId) {
    if (!currentJob || currentJob.jobId !== jobId) return [];
    return currentJob.results.filter(r => !r.ok).map(r => r.login);
  }

  function isRunning() {
    return currentJob?.status === 'running';
  }

  function lastJobId() {
    return currentJob?.jobId ?? null;
  }

  return { start, subscribe, getSnapshot, getFailedLogins, isRunning, lastJobId };
}
