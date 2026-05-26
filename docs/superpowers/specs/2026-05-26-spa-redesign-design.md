# SPA Redesign with React + shadcn — Design

**Дата:** 2026-05-26
**Статус:** Утверждено к реализации
**Связанные документы:**
- [`2026-05-24-twitch-multi-sender-design.md`](2026-05-24-twitch-multi-sender-design.md) — базовая система
- [`2026-05-25-quick-send-design.md`](2026-05-25-quick-send-design.md) — последняя UI-фича

## 1. Цель

Переписать клиентскую часть приложения с server-rendered vanilla HTML на современный SPA (React + TypeScript + Vite + TailwindCSS + shadcn/ui). UX остаётся идентичным; меняется только визуальная подача, стек и архитектура клиента. Бэкенд (Express API) и все 60 тестов не трогаются.

Палитра — **zinc** (холодный нейтральный серый), тема — **тёмная по умолчанию**, routing — **React Router** (`/`, `/accounts`, `/proxies`, `/settings`), login-страница **остаётся server-rendered**.

## 2. Не-цели (явно вне scope)

- Изменения UX или функционала (поведение всех страниц идентично текущему)
- Переключатель светлой/тёмной темы (только тёмная)
- React unit-тесты (Playwright/Vitest) — manual smoke только
- Изменения в `routes/api.js`, `auth.js`, `csrf.js`, `store.js`, `sender.js`, `twitch.js`
- Изменения в существующих 60 тестах
- Изменения в `.env`, `Caddyfile.example`, `systemd/twitch-sender.service`, deploy-процессе кроме одного нового `npm run build` шага

## 3. Архитектура

```
[Browser SPA] ──HTTPS──> [Caddy :443] ──> [Express :3000]
                                              │
                                              ├─ /login, POST /login, /logout   →  server-rendered (без изменений в auth-flow)
                                              ├─ /api/*                         →  JSON + SSE (без изменений)
                                              ├─ /style.css, /app.js (нет)      →  удалены
                                              └─ /* (catch-all для SPA routes)  →  static dist/index.html
                                                                                       ↓
                                                                                   React SPA с React Router
```

**Что меняется в backend:**
- В `server.js` добавляется catch-all GET роут (после API и login роутов): `app.get('*', requireAuth, (req, res) => res.sendFile(...dist/index.html))`. Только для GET, только для не-/api, не-/login, не-/logout.
- В `routes/pages.js` удаляются роуты `/`, `/accounts`, `/proxies`, `/settings`. Остаётся только `/login`.
- `app.use(express.static(path.join(__dirname, 'dist')))` добавляется перед catch-all (или одновременно — Express статика автоматически отдаёт реальные файлы и пропускает остальное).

**Что меняется на стороне клиента:**
- Удаляются: `public/app.js`, `public/style.css`, `views/main.js`, `views/accounts.js`, `views/proxies.js`, `views/settings.js`, `views/layout.js`. Папка `public/` остаётся пустой (или удаляется).
- Остаётся: `views/login.js` (рестайл под Tailwind через CDN-скрипт для визуальной консистентности с SPA).
- Появляется: вся структура `frontend/` с Vite SPA.

## 4. Структура проекта

```
mitch/
├── (бэкенд — изменения минимальны)
│   ├── server.js                    # + catch-all SPA fallback, + express.static('dist')
│   ├── auth.js, csrf.js, store.js, sender.js, twitch.js  # без изменений
│   ├── routes/api.js                # без изменений
│   ├── routes/pages.js              # только /login
│   ├── views/login.js               # рестайл под Tailwind CDN, zinc-палитра
│   ├── test/, scripts/, data/, .env
│
├── frontend/                        # NEW: Vite SPA исходники
│   ├── index.html                   # entry
│   ├── vite.config.ts               # proxy /api,/login,/logout → :3000
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   ├── tailwind.config.ts           # zinc theme, darkMode: ['class']
│   ├── postcss.config.js
│   ├── components.json              # shadcn config
│   └── src/
│       ├── main.tsx                 # React entry
│       ├── App.tsx                  # Router + layout shell + ToastProvider
│       ├── lib/
│       │   ├── api.ts               # fetch helpers + типы Account/Proxy/Settings/JobEvent/SendResult
│       │   ├── utils.ts             # cn() стандарт shadcn
│       │   └── error-labels.ts      # ERROR_LABELS + STAGE_LABELS
│       ├── hooks/
│       │   ├── useSSE.ts            # EventSource обёртка
│       │   └── useJobState.ts       # rows/counts/summary/elapsed
│       ├── components/
│       │   ├── ui/                  # shadcn-сгенерированные: button, input, textarea, label, card, table, badge, sonner, scroll-area, collapsible, separator
│       │   ├── Nav.tsx              # верхняя навигация
│       │   ├── QuickSend.tsx        # quick-send панель (input + input + send)
│       │   ├── JobStats.tsx         # 6 счётчиков + Elapsed + ETA
│       │   ├── EventLog.tsx         # хронологический лог в Card + ScrollArea
│       │   └── ProgressTable.tsx    # shadcn Table с per-row статусом
│       ├── pages/
│       │   ├── MainPage.tsx         # / — composition above + buttons
│       │   ├── AccountsPage.tsx     # /accounts — table editor + bulk import
│       │   ├── ProxiesPage.tsx      # /proxies — аналогично
│       │   └── SettingsPage.tsx     # /settings — обычная форма
│       └── styles/
│           └── globals.css          # @tailwind + shadcn CSS-переменные (zinc dark)
│
├── dist/                            # gitignored — Vite build output
├── package.json                     # +deps, +scripts
├── .gitignore                       # +dist/
└── ... (остальное без изменений)
```

## 5. package.json дополнения

**Новые dependencies:**
- `react`, `react-dom`, `react-router-dom`
- `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `sonner`

**Новые devDependencies:**
- `vite`, `@vitejs/plugin-react`
- `typescript`, `@types/react`, `@types/react-dom`, `@types/node`
- `tailwindcss`, `postcss`, `autoprefixer`
- `npm-run-all` (параллельный запуск dev:server + dev:client)

**Новые / обновлённые scripts:**
```json
"start": "node server.js",
"build": "vite build --config frontend/vite.config.ts",
"dev:server": "node --watch server.js",
"dev:client": "vite --config frontend/vite.config.ts",
"dev": "npm-run-all --parallel dev:server dev:client",
"test": "node --test \"test/*.test.js\"",
"test:watch": "node --test --watch \"test/*.test.js\"",
"hash": "node scripts/hash.js"
```

## 6. Конфиги

### `frontend/vite.config.ts`

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') }
  },
  build: {
    outDir: path.resolve(__dirname, '..', 'dist'),
    emptyOutDir: true
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/login': 'http://127.0.0.1:3000',
      '/logout': 'http://127.0.0.1:3000'
    }
  }
});
```

### `frontend/tailwind.config.ts`

```ts
import type { Config } from 'tailwindcss';

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // shadcn-стандарт: ссылки на CSS-переменные определённые в globals.css
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' }
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      }
    }
  },
  plugins: []
} satisfies Config;
```

### `frontend/components.json` (shadcn config)

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/styles/globals.css",
    "baseColor": "zinc",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui"
  }
}
```

### `frontend/src/styles/globals.css`

Стандартный shadcn-сетап с zinc dark palette:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root.dark {
    --background: 240 10% 3.9%;
    --foreground: 0 0% 98%;
    --card: 240 10% 3.9%;
    --card-foreground: 0 0% 98%;
    --popover: 240 10% 3.9%;
    --popover-foreground: 0 0% 98%;
    --primary: 0 0% 98%;
    --primary-foreground: 240 5.9% 10%;
    --secondary: 240 3.7% 15.9%;
    --secondary-foreground: 0 0% 98%;
    --muted: 240 3.7% 15.9%;
    --muted-foreground: 240 5% 64.9%;
    --accent: 240 3.7% 15.9%;
    --accent-foreground: 0 0% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 3.7% 15.9%;
    --input: 240 3.7% 15.9%;
    --ring: 240 4.9% 83.9%;
    --radius: 0.5rem;
  }
  body { @apply bg-background text-foreground; }
  html { @apply dark; }
}
```

## 7. Backend изменения

### `server.js` (только эти строки)

После `app.use('/api', requireAuth, csrf, apiRouter({...}));` и перед `app.listen(...)`:

```js
// SPA static + fallback
app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});
```

`express.static(path.join(__dirname, 'public'))` в текущем `server.js` заменяется на `express.static(path.join(__dirname, 'dist'))`. После refactor папка `public/` пустеет (`app.js` и `style.css` удалены), её можно тоже удалить или оставить пустой.

Порядок middleware в `server.js`:
1. Cookie parser, JSON parser, urlencoded parser (без изменений)
2. Auth endpoints (`POST /login`, `GET /logout`) (без изменений)
3. `express.static('dist')` — статика SPA (заменяет `express.static('public')`)
4. `pagesRouter` (только GET `/login`)
5. `apiRouter` (защищён `requireAuth` + `csrf`) (без изменений)
6. **Catch-all SPA fallback** (защищён `requireAuth`) — новая строка
7. `app.listen` (без изменений)

### `routes/pages.js`

Полная новая версия (только login):

```js
import { Router } from 'express';
import { loginPage } from '../views/login.js';

export function pagesRouter() {
  const r = Router();
  r.get('/login', (req, res) => res.type('html').send(loginPage()));
  return r;
}
```

Тесты этот файл не покрывают, изменение безопасно.

### `views/login.js`

Подключить Tailwind CDN и переписать классы. Это server-rendered HTML, поэтому используем простой Play CDN (один `<script>` тег), не билдим. Контент:

```js
export function loginPage({ error } = {}) {
  return `<!doctype html><html class="dark"><head>
<meta charset="utf-8"><title>Login</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config = { darkMode: ['class'], theme: { extend: {} } }</script>
</head><body class="bg-zinc-950 text-zinc-50 min-h-screen flex items-center justify-center">
<form method="post" action="/login" class="w-80 p-6 bg-zinc-900 border border-zinc-800 rounded-lg flex flex-col gap-3">
  <h1 class="text-xl font-semibold">Twitch Sender</h1>
  <input type="password" name="password" placeholder="Password" required autofocus
    class="px-3 py-2 bg-zinc-950 border border-zinc-800 rounded text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-500">
  <button type="submit"
    class="px-3 py-2 bg-zinc-50 text-zinc-950 rounded font-medium hover:bg-zinc-200">Login</button>
  ${error ? `<p class="text-red-400 text-sm">${error}</p>` : ''}
</form>
</body></html>`;
}
```

CDN Tailwind — runtime, не для прод обычно, но для одного экрана login на личном инструменте это ОК.

## 8. Frontend — ключевые модули

### `frontend/src/lib/api.ts`

```ts
export type Account = { login: string; oauthToken: string };
export type Proxy = { host: string; port: number; username?: string; password?: string };
export type Settings = {
  channel: string; word: string;
  accountsPerProxy: number; spreadSeconds: number; concurrency: number;
};
export type SendResult = { ok: boolean; error?: string; durationMs: number };
export type JobEvent =
  | { type: 'sending'; login: string; proxy: string }
  | { type: 'stage'; login: string; stage: 'connecting'|'auth'|'join'|'sent'|'waiting' }
  | { type: 'progress'; login: string; proxy: string; result: SendResult }
  | { type: 'done'; jobId: string; summary: { total: number; ok: number; failed: number } };

async function request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  if (res.status === 401) { window.location.href = '/login'; return null; }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {})
};
```

### `frontend/src/lib/error-labels.ts`

```ts
export const ERROR_LABELS: Record<string, string> = {
  token_invalid: 'Токен невалиден или протух',
  proxy_unreachable: 'Прокси не отвечает',
  proxy_auth_failed: 'Прокси: неверный логин/пароль',
  twitch_unreachable: 'Twitch недоступен',
  chat_blocked: 'Аккаунт заблокирован в чате',
  join_failed: 'Не удалось войти в канал',
  timeout: 'Превышено время ожидания (15 сек)',
  unknown: 'Неизвестная ошибка',
  bulk_running: 'Идёт bulk-send, подожди завершения',
  unknown_account: 'Аккаунт не найден',
  empty_message: 'Введи сообщение',
  no_channel: 'В Settings не задан канал'
};
export const STAGE_LABELS: Record<string, string> = {
  connecting: 'подключение',
  auth: 'авторизация',
  join: 'вход в канал',
  sent: 'отправлено',
  waiting: 'подтверждение'
};
export const errLabel = (code?: string) => code ? (ERROR_LABELS[code] ?? code) : '';
```

### `frontend/src/hooks/useSSE.ts`

```ts
import { useEffect, useState } from 'react';
import type { JobEvent } from '@/lib/api';

export function useSSE(jobId: string | null): JobEvent[] {
  const [events, setEvents] = useState<JobEvent[]>([]);
  useEffect(() => {
    if (!jobId) return;
    const es = new EventSource(`/api/progress?jobId=${encodeURIComponent(jobId)}`);
    const push = (e: MessageEvent) => setEvents(prev => [...prev, JSON.parse(e.data)]);
    ['sending', 'stage', 'progress', 'done'].forEach(t => es.addEventListener(t, push as EventListener));
    es.addEventListener('done', () => es.close());
    return () => es.close();
  }, [jobId]);
  return events;
}
```

### Логика страниц

- **`MainPage`** — fetch settings/accounts/proxies на mount, useState для jobId, передача в useSSE. Render: QuickSend → settings summary card → Send/Retry buttons → JobStats → EventLog → ProgressTable.
- **`AccountsPage`** — useState массива rows, fetch GET /api/accounts на mount. Add row, delete row, bulk import (тот же combo-list/TSV парсер). PUT /api/accounts на save. Toast «Saved» или «Errors: ...».
- **`ProxiesPage`** — аналогично с типом Proxy.
- **`SettingsPage`** — useState всех 5 полей, fetch GET /api/settings, PUT при submit.

### Состояния выглядят так

```ts
// useJobState внутри MainPage
const [jobId, setJobId] = useState<string | null>(null);
const events = useSSE(jobId);
const { rows, counts, summary, elapsed, failedLogins } = useMemo(
  () => deriveJobState(events, startTime),
  [events, startTime]
);
```

## 9. Обработка ошибок

- 401 на любом fetch → авто-redirect на `/login` (внутри `api.ts`)
- Network errors → toast «Сетевая ошибка»
- 4xx с `{error}` → toast с `errLabel(error)`
- 409 при `POST /api/send` → подключаемся к существующему job через возвращённый `jobId`
- 409 при `POST /api/quick-send` → toast `bulk_running`
- React Error Boundary на верхнем уровне → fallback с кнопкой «Reload»
- SSE — EventSource сам пытается reconnect; если jobId уже не существует — 404, прерываем

## 10. Тестирование

- **Существующие 60 тестов остаются зелёными** — они тестируют только API/backend, никакого фронта
- НЕ добавляем React unit/integration тестов в первой версии (overkill для одного юзера)
- `npm run build` должен пройти без ошибок TypeScript — это де-факто тест компиляции
- Manual smoke (см. секцию 11)

## 11. Manual smoke checklist

Запустить `npm run build && npm start`, открыть в браузере:

1. `/login` — рендерится с тёмной zinc-палитрой, форма работает, после ввода пароля редирект на `/`
2. `/` — навигация наверху, Quick Send панель, settings summary, Send / Retry кнопки, пустая таблица
3. Заполнить `/accounts` — добавить 1 строку, save, перезагрузить — данные сохранены
4. Заполнить `/proxies` — аналогично
5. Заполнить `/settings` — все 5 полей сохраняются и читаются
6. `/` — Send → progress появляется, ETA тикает, EventLog заполняется, ProgressTable обновляется
7. Quick Send — выбрать логин из datalist (или Combobox), отправить — toast/inline статус показывается
8. Bulk send → Quick Send disabled на время → enabled после done
9. F5 на `/accounts` → обратно открывается /accounts (React Router fallback в Express работает)
10. Logout → редирект на /login → cookie очищена

## 12. Деплой (что меняется в README)

Один новый шаг в VPS-инструкции:

```bash
# После git pull + npm ci
npm run build
# затем systemctl restart twitch-sender
```

systemd unit не меняется — он по-прежнему запускает `node server.js`. Express теперь отдаст `dist/index.html` вместо старого SPA-роутера.

## 13. Открытые вопросы

(Нет — все ключевые решения приняты в брейншторме.)

## 14. Риски и митигации

- **Риск:** новые зависимости (React, TS, Vite) увеличивают `node_modules` в 5-10 раз. **Митигация:** один проект, один npm install, dist/ компактен после билда.
- **Риск:** Tailwind CDN на login-странице медленнее серверной CSS. **Митигация:** одна страница, грузится один раз, кешируется.
- **Риск:** SSE через React-хук может leak'ать соединение если jobId меняется быстро. **Митигация:** cleanup в useEffect (es.close()) обязателен.
- **Риск:** регрессии в UX. **Митигация:** обязательный manual smoke по checklist'у перед merge.
