import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';

export function assignProxy(index, proxies, accountsPerProxy) {
  if (!proxies?.length) return null;
  const group = Math.floor(index / accountsPerProxy);
  return proxies[group % proxies.length];
}

export function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createSender({ sendOne, rng = Math.random }) {
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
      startedAt: Date.now(),
      cancelled: false,
      pendingTasks: new Set()
    };
    currentJob = job;
    listenersByJob.set(jobId, new Set());

    const limit = pLimit(Math.max(1, settings.concurrency || 1));
    const interval = (settings.spreadSeconds * 1000) / Math.max(1, accounts.length);

    function markStopped(task) {
      if (task.done) return;
      task.done = true;
      job.results.push({ login: task.account.login, proxy: task.proxyLabel, ok: false, stopped: true });
      emit(jobId, { type: 'progress', login: task.account.login, proxy: task.proxyLabel, result: { ok: false, stopped: true } });
      task.resolve();
    }
    job.markStopped = markStopped;

    const order = shuffle(accounts.map((_, i) => i), rng);
    const tasks = order.map((accIdx, pos) => {
      const account = accounts[accIdx];
      const proxy = assignProxy(accIdx, proxies, settings.accountsPerProxy);
      const proxyLabel = proxy ? `${proxy.host}:${proxy.port}` : 'direct';
      const delay = pos * interval;
      return new Promise((resolve) => {
        const task = { timer: null, resolve, account, proxyLabel, done: false };
        task.timer = setTimeout(() => {
          job.pendingTasks.delete(task);
          if (job.cancelled) return markStopped(task);
          limit(async () => {
            emit(jobId, { type: 'sending', login: account.login, proxy: proxyLabel });
            const result = await sendOne(account, proxy, settings.channel, settings.word, {
              onStage: (stage) => emit(jobId, { type: 'stage', login: account.login, stage })
            });
            const entry = { login: account.login, proxy: proxyLabel, ...result };
            job.results.push(entry);
            emit(jobId, { type: 'progress', login: account.login, proxy: proxyLabel, result });
          }).then(resolve, resolve);
        }, delay);
        job.pendingTasks.add(task);
      });
    });

    Promise.all(tasks).then(() => {
      if (job.status === 'running') job.status = 'done';
      const ok = job.results.filter(r => r.ok).length;
      const stopped = job.results.filter(r => r.stopped).length;
      const failed = job.results.length - ok - stopped;
      const summary = { total: accounts.length, ok, failed, stopped };
      emit(jobId, { type: 'done', jobId, summary });
      setTimeout(() => {
        listenersByJob.delete(jobId);
        if (currentJob?.jobId === jobId) currentJob = null;
      }, 5 * 60 * 1000);
    });

    return { jobId };
  }

  function stop(jobId) {
    if (!currentJob || currentJob.jobId !== jobId || currentJob.status !== 'running') return false;
    const job = currentJob;
    job.cancelled = true;
    job.status = 'stopped';
    for (const task of job.pendingTasks) {
      clearTimeout(task.timer);
      job.markStopped(task);
    }
    job.pendingTasks.clear();
    return true;
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
    return currentJob.results.filter(r => !r.ok && !r.stopped).map(r => r.login);
  }

  function isRunning() {
    return currentJob?.status === 'running';
  }

  function lastJobId() {
    return currentJob?.jobId ?? null;
  }

  return { start, stop, subscribe, getSnapshot, getFailedLogins, isRunning, lastJobId };
}
