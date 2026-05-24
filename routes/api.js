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

  return r;
}
