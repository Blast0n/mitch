import { Router } from 'express';
import { loginPage } from '../views/login.js';
import { mainPage } from '../views/main.js';
import { accountsPage } from '../views/accounts.js';
import { proxiesPage } from '../views/proxies.js';
import { settingsPage } from '../views/settings.js';

export function pagesRouter({ store, requireAuth }) {
  const r = Router();

  r.get('/login', (req, res) => res.type('html').send(loginPage()));

  r.get('/', requireAuth, async (req, res) => {
    const [settings, accounts, proxies] = await Promise.all([
      store.read('settings'), store.read('accounts'), store.read('proxies')
    ]);
    res.type('html').send(mainPage({ settings, counts: { accounts: accounts.length, proxies: proxies.length } }));
  });

  r.get('/accounts', requireAuth, (req, res) => res.type('html').send(accountsPage()));
  r.get('/proxies', requireAuth, (req, res) => res.type('html').send(proxiesPage()));
  r.get('/settings', requireAuth, (req, res) => res.type('html').send(settingsPage()));

  return r;
}
