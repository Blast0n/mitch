import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import { Store } from './store.js';
import { makeMiddleware, verifyPassword, buildCookie, COOKIE_NAME } from './auth.js';
import { makeCsrfMiddleware } from './csrf.js';
import { createSender } from './sender.js';
import { sendOne } from './twitch.js';
import { pagesRouter } from './routes/pages.js';
import { apiRouter } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  PORT = 3000,
  APP_PASSWORD_HASH,
  SESSION_SECRET,
  COOKIE_DAYS = 7,
  PUBLIC_ORIGIN
} = process.env;

if (!APP_PASSWORD_HASH || !SESSION_SECRET) {
  console.error('APP_PASSWORD_HASH and SESSION_SECRET are required in .env');
  process.exit(1);
}

const cookieMaxAgeMs = Number(COOKIE_DAYS) * 86_400_000;
const store = new Store(path.join(__dirname, 'data'));
const sender = createSender({ sendOne });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

// Cookie parser (minimal)
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      req.cookies[k] = decodeURIComponent(v.join('='));
    }
  }
  next();
});

const requireAuth = makeMiddleware({ secret: SESSION_SECRET, cookieMaxAgeMs });
const csrf = PUBLIC_ORIGIN ? makeCsrfMiddleware({ expectedOrigin: PUBLIC_ORIGIN }) : (req, res, next) => next();

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });

// Public auth endpoints
app.post('/login', loginLimiter, async (req, res) => {
  const password = req.body?.password;
  if (typeof password !== 'string') return res.redirect('/login');
  if (await verifyPassword(password, APP_PASSWORD_HASH)) {
    const cookie = buildCookie(SESSION_SECRET);
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(cookieMaxAgeMs / 1000)}${PUBLIC_ORIGIN?.startsWith('https://') ? '; Secure' : ''}`);
    return res.redirect('/');
  }
  res.status(401).type('html').send('<p>Wrong password. <a href="/login">try again</a></p>');
});
app.use(express.urlencoded({ extended: false }));
app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.redirect('/login');
});

// Static
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use(pagesRouter({ store, requireAuth }));
app.use('/api', requireAuth, csrf, apiRouter({ store, sender }));

app.listen(PORT, '127.0.0.1', () => console.log(`listening http://127.0.0.1:${PORT}`));
