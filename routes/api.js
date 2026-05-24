import { Router } from 'express';
import { validateAccounts, validateProxies, validateSettings } from '../store.js';

export function apiRouter({ store, sender }) {
  const r = Router();

  const crud = (name, validate) => {
    r.get(`/${name}`, async (req, res) => res.json(await store.read(name)));
    r.put(`/${name}`, async (req, res) => {
      const errors = validate(req.body);
      if (errors.length) return res.status(400).json({ errors });
      await store.write(name, req.body);
      res.status(204).end();
    });
  };
  crud('accounts', validateAccounts);
  crud('proxies', validateProxies);
  crud('settings', validateSettings);

  r.post('/send', async (req, res) => {
    const [accounts, proxies, settings] = await Promise.all([
      store.read('accounts'), store.read('proxies'), store.read('settings')
    ]);
    if (!accounts.length) return res.status(400).json({ error: 'no_accounts' });
    if (!settings.channel) return res.status(400).json({ error: 'no_channel' });
    if (!settings.word) return res.status(400).json({ error: 'no_word' });
    try {
      const { jobId } = sender.start({ accounts, proxies, settings });
      res.status(202).json({ jobId });
    } catch (err) {
      if (/JobAlreadyRunning/.test(err.message)) return res.status(409).json({ error: 'job_running', jobId: sender.lastJobId() });
      throw err;
    }
  });

  r.post('/send/retry-failed', async (req, res) => {
    const [accountsAll, proxies, settings] = await Promise.all([
      store.read('accounts'), store.read('proxies'), store.read('settings')
    ]);
    const lastId = sender.lastJobId();
    if (!lastId) return res.status(400).json({ error: 'no_previous_job' });
    const failedLogins = sender.getFailedLogins(lastId);
    if (!failedLogins.length) return res.status(400).json({ error: 'no_failed' });
    const accounts = accountsAll.filter(a => failedLogins.includes(a.login));
    if (!accounts.length) return res.status(400).json({ error: 'no_failed' });
    try {
      const { jobId } = sender.start({ accounts, proxies, settings });
      res.status(202).json({ jobId });
    } catch (err) {
      if (/JobAlreadyRunning/.test(err.message)) return res.status(409).json({ error: 'job_running' });
      throw err;
    }
  });

  r.get('/progress', (req, res) => {
    const jobId = req.query.jobId;
    if (!jobId) return res.status(400).json({ error: 'jobId required' });

    const snapshotPre = sender.getSnapshot(jobId);
    if (!snapshotPre && sender.lastJobId() !== jobId) {
      return res.status(404).json({ error: 'job_not_found' });
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();

    const snapshot = sender.getSnapshot(jobId);
    if (snapshot) {
      for (const r of snapshot.results) {
        res.write(`event: progress\ndata: ${JSON.stringify({ login: r.login, proxy: r.proxy, result: { ok: r.ok, error: r.error, durationMs: r.durationMs } })}\n\n`);
      }
      if (snapshot.status === 'done') {
        const ok = snapshot.results.filter(r => r.ok).length;
        const total = snapshot.results.length;
        res.write(`event: done\ndata: ${JSON.stringify({ jobId, summary: { total, ok, failed: total - ok } })}\n\n`);
        return res.end();
      }
    }

    const unsubscribe = sender.subscribe(jobId, (event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done') {
        res.end();
      }
    });

    req.on('close', () => unsubscribe());
  });

  return r;
}
