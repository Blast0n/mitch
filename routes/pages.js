import { Router } from 'express';
import { loginPage } from '../views/login.js';

export function pagesRouter() {
  const r = Router();
  r.get('/login', (req, res) => res.type('html').send(loginPage()));
  return r;
}
