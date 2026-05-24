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

  return r;
}
