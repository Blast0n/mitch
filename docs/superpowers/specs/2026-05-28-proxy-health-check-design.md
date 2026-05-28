# Proxy Health Check — Design

**Дата:** 2026-05-28
**Статус:** Утверждено к реализации
**Связанные документы:** [`2026-05-24-twitch-multi-sender-design.md`](2026-05-24-twitch-multi-sender-design.md) (базовая система)

## 1. Цель

Дать пользователю способ узнать, какие SOCKS5-прокси из его списка живы, **до** запуска рассылки. Сегодня дохлый прокси обнаруживается только во время `/send` — в виде ошибки `proxy_unreachable` в таблице прогресса.

Добавляем on-demand health-check: кнопка на странице `/proxies`, статус каждой строки в таблице, и подтверждение перед `/send`, если есть помеченные мёртвыми прокси.

## 2. Функциональные требования

1. На `/proxies` появляется колонка **Status** с бэйджем для каждой строки: `✓ Nms` (живой), `× <ошибка>` (мёртвый) или `—` (не проверялся).
2. Под бэйджем — относительное время последней проверки (`«checked 2m ago»`) мелким `text-muted-foreground`.
3. Кнопка **Check all** рядом с `+ Row` / `Save` — проверяет все строки списка параллельно.
4. Per-row кнопка-иконка (`Activity` из `lucide-react`) — проверяет одну строку.
5. Во время идущего чека все кнопки чека (`Check all` и per-row) — `disabled`. Параллельные нажатия не разрешаются (один in-flight чек на процесс).
6. Если юзер пытается запустить второй чек, пока идёт первый — toast «Проверка уже идёт» (на основе `409 check_running`).
7. При нажатии **Send** на главной — если в health-store есть прокси с `ok: false`, показать `window.confirm(\`${dead} прокси помечены как мёртвые — аккаунты на них могут упасть. Продолжить?\`)`. На отмену — send не запускается. Прокси без записи (никогда не проверялись) считаются `unknown` и **не** триггерят warning.
8. QuickSend не получает confirm-обработку: это разовая отправка через один прокси, юзер увидит ошибку мгновенно.
9. Health-check **не блокирует** `/send` и наоборот: можно чекать прокси, пока идёт рассылка.
10. Health-check **не модифицирует** `assignProxy` — распределение аккаунтов по прокси остаётся «слепым». Health чисто информационный (политика «warn but proceed»).

## 3. Нефункциональные требования

- Health-store — **in-memory**, чистится при рестарте сервера. Никаких изменений в `proxies.json` или `data/`.
- Глубина проверки: SOCKS5-handshake + TCP-connect через прокси к `irc-ws.chat.twitch.tv:443`. WebSocket upgrade не делается, Twitch-IRC не трогается, OAuth-токены аккаунтов не используются.
- Таймаут на одну пробу — 5 сек (хардкод, как `overallTimeoutMs` в `sendOne`).
- Параллельность `checkMany` — `p-limit(8)`.
- Новая прямая зависимость в `package.json`: `socks` (уже в дереве как транзитивная через `socks-proxy-agent`).
- Никаких новых runtime-зависимостей на фронте.
- Все строки UI на русском (как остальной интерфейс).

## 4. Архитектура

Изолированный новый модуль + точечные дополнения в существующих местах:

```
[ProxiesPage] ──POST /api/proxies/check──► [api.js] ──► [proxyHealth.checkMany] ──SOCKS5──► proxy ──TCP──► irc-ws.chat.twitch.tv:443
       │                                       │
       │                                       └──► [healthStore.set(key, entry)]
       │
       └──GET /api/proxies/health──► [api.js] ──► [healthStore.getAll()]

[MainPage Send] ──GET /api/proxies + GET /api/proxies/health──► (клиент считает deadCount) ──confirm──► POST /api/send
```

`sender.js`, `twitch.js`, `store.js`, `proxies.json` — не меняются.

### Новые файлы

- `proxyHealth.js` — `checkOne(proxy, opts)`, `checkMany(proxies, opts)`. Транспорт инжектится через `opts.transport`.
- `healthStore.js` — `createHealthStore()`. In-memory `Map`, keyed by `host:port|user|pass`.
- `test/proxyHealth.test.js`, `test/healthStore.test.js`, `test/api.proxies.check.test.js`.
- `frontend/src/lib/proxyKey.ts` — общий хелпер `keyOf(proxy)` для `ProxiesPage` и `MainPage`.

### Изменения в существующих файлах

- `server.js` — создать `healthStore` и инжектнуть в `apiRouter` рядом с `sender`.
- `routes/api.js` — добавить `POST /api/proxies/check`, `GET /api/proxies/health`. Принимают `{ store, sender, healthStore, checkOne }` через DI.
- `package.json` — добавить `socks` в `dependencies` как прямую зависимость.
- `frontend/src/lib/api.ts` — типы `ProxyHealthEntry`, `ProxyHealthResponse`.
- `frontend/src/lib/error-labels.ts` — поправить лейбл `timeout` (убрать «(15 сек)» — теперь у нас два разных таймаута, 15 сек для `sendOne` и 5 сек для health-чека; генеричный лейбл подходит обоим). `proxy_auth_failed`, `proxy_unreachable`, `twitch_unreachable`, `unknown` уже есть.
- `frontend/src/pages/ProxiesPage.tsx` — колонка Status, `Check all`, per-row check, хук `useProxyHealth`.
- `frontend/src/pages/MainPage.tsx` — preflight перед `POST /api/send`.

## 5. Логика пробы

```js
async function checkOne(proxy, opts = {}) {
  const transport = opts.transport ?? defaultSocksTransport;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const destination = opts.destination ?? { host: 'irc-ws.chat.twitch.tv', port: 443 };
  const start = Date.now();
  try {
    const socket = await transport.connect({ proxy, destination, timeoutMs });
    socket.destroy();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: classify(err), details: err.message, latencyMs: Date.now() - start };
  }
}
```

Дефолтный транспорт — обёртка над `SocksClient.createConnection({ proxy: { host, port, type: 5, userId, password }, destination, command: 'connect' })` из пакета `socks`, с явным `setTimeout(timeoutMs)`, который реджектит, если SOCKS-стек ещё не успел отдать результат.

`checkMany(proxies, opts)`:

```js
async function checkMany(proxies, opts = {}) {
  const limit = pLimit(opts.concurrency ?? 8);
  return Promise.all(proxies.map(p => limit(() => checkOne(p, opts))));
}
```

Порядок результатов = порядок входа.

## 6. Классификация ошибок

`classify(err)` маппит ошибки `socks` пакета в один из пяти классов:

| Класс | Источник | Что означает |
|-------|----------|--------------|
| `timeout` | внутренний `setTimeout` истёк | Прокси не ответил за `timeoutMs` |
| `proxy_unreachable` | `ECONNREFUSED` / `ETIMEDOUT` / `EHOSTUNREACH` / `ENOTFOUND` | TCP до прокси не открылся |
| `proxy_auth_failed` | SOCKS reply «Authentication failed» / `socks` package errors с упоминанием auth | SOCKS5 отклонил `userId`/`password` |
| `twitch_unreachable` | SOCKS reply codes «Host unreachable» / «Connection refused» (туннель открыт, но destination не дошёл) | Прокси работает, но не может дотянуться до `irc-ws.chat.twitch.tv:443` |
| `unknown` | всё остальное | Fallback с `details: err.message` |

`proxy_auth_failed` — отдельный класс, в отличие от `sendOne`, где он схлопнут в `proxy_unreachable`. Это полезно в UI: «прокси живой, но логин/пароль неверны».

## 7. Health-store

### Ключ

```js
export const keyOf = (p) => `${p.host}:${p.port}|${p.username ?? ''}|${p.password ?? ''}`;
```

Намеренные следствия:
- Любое редактирование `host`/`port`/`username`/`password` → новый ключ → статус «исчезает» (запись остаётся в map'е, но не сматчится). Это правильно: «я поменял пароль — статус надо перепроверить».
- Две строки с одинаковым `host:port:user:pass` делят одну запись. Это правильно: одинаковый прокси — одинаковое здоровье.

### API store'а

```js
export function createHealthStore() {
  const map = new Map();   // key -> { ok, latencyMs, checkedAt, error?, details? }
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, entry) => map.set(key, entry),
    getAll: () => Array.from(map.entries()).map(([key, entry]) => ({ key, ...entry })),
    getEntriesFor: (proxies) => proxies.map(p => ({ key: keyOf(p), entry: map.get(keyOf(p)) ?? null })),
    getDeadCount: (proxies) => proxies.filter(p => map.get(keyOf(p))?.ok === false).length,
  };
}
```

`getDeadCount` считает **только** прокси с записью `ok: false`. Прокси без записи (никогда не проверялся) → `unknown` → не входит в счётчик dead.

Без TTL, без чистки. Размер map'а ограничен количеством уникальных `host:port|user|pass` комбинаций, которые юзер когда-либо проверял в текущей сессии процесса.

## 8. API

### `POST /api/proxies/check`

**Auth:** да (требует cookie + CSRF, как все `/api/*`).

**Body:**
```json
{ "indices": [0, 2] }
```
или `{}` (или вообще без body) — чекнуть все.

**Validation:**
- Если `indices` есть: должен быть массивом целых в диапазоне `[0, proxies.length)`. Иначе `400 { error: 'invalid_indices' }`.

**Concurrency lock:** один in-flight чек на процесс. Второй POST пока первый не завершился → `409 { error: 'check_running' }`.

**Логика:**
1. Прочитать `proxies.json`.
2. Выбрать прокси по `indices` (или все).
3. Вызвать `checkMany(selected)`.
4. Для каждого результата записать в healthStore: `healthStore.set(keyOf(proxy), { ok, latencyMs, checkedAt: Date.now(), error?, details? })`.
5. Снять лок.

**Response 200:**
```json
{
  "results": [
    { "index": 0, "key": "1.2.3.4:1080||", "ok": true, "latencyMs": 234, "checkedAt": 1748448000000 },
    { "index": 2, "key": "5.6.7.8:1080|user|pass", "ok": false, "error": "proxy_unreachable", "details": "ECONNREFUSED", "latencyMs": 2003, "checkedAt": 1748448002003 }
  ]
}
```

### `GET /api/proxies/health`

**Auth:** да.

**Body:** нет.

**Response 200:**
```json
{
  "entries": [
    { "key": "1.2.3.4:1080||", "ok": true, "latencyMs": 234, "checkedAt": 1748448000000 },
    { "key": "5.6.7.8:1080|user|pass", "ok": false, "error": "proxy_unreachable", "details": "ECONNREFUSED", "latencyMs": 2003, "checkedAt": 1748448002003 }
  ]
}
```

Дамп всего map'а. Фронт сам мерджит по `key`.

## 9. Фронтенд

### `ProxiesPage.tsx`

Добавляется хук:

```ts
function useProxyHealth() {
  const [byKey, setByKey] = useState<Record<string, ProxyHealthEntry>>({});
  const refresh = useCallback(async () => {
    const r = await api.get<ProxyHealthResponse>('/api/proxies/health');
    if (r) setByKey(Object.fromEntries(r.entries.map(e => [e.key, e])));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { byKey, refresh };
}
```

В таблице — новый header `<TableHead>Status</TableHead>` между `Pass` и колонкой удаления. В каждой строке:

```tsx
const key = keyOf(toProxy(row));
const entry = byKey[key];
// Badge:
//   entry?.ok === true  → <Badge variant="default">✓ {latencyMs}ms</Badge>
//   entry?.ok === false → <Badge variant="destructive">× {errLabel(entry.error)}</Badge>
//   entry == null       → <span className="text-muted-foreground">—</span>
// Под бэйджем: <span className="text-xs text-muted-foreground">checked {relativeTime(entry.checkedAt)}</span>
```

`relativeTime` — простая локальная функция, форматирующая разницу `Date.now() - checkedAt` в `«just now»` / `«2m ago»` / `«5h ago»` (на русском: `«только что»` / `«2 мин назад»` / `«5 ч назад»`).

**Кнопки:**

- `<Button onClick={checkAll} disabled={checking}>Check all</Button>` — POST `/api/proxies/check` без body. По завершении — `refresh()`.
- Per-row: `<Button size="icon" variant="ghost" onClick={() => checkOne(i)} disabled={checking}><Activity className="h-4 w-4"/></Button>` — POST `/api/proxies/check` с `{ indices: [i] }`. По завершении — `refresh()`.
- `409 check_running` → `toast.error('Проверка уже идёт')`.

`checking: boolean` — локальный state, выставляется в `true` на время in-flight чека (любого), сбрасывается в `finally`.

**Save-сценарий:** при сохранении проксей health-записи под старыми ключами **не** сбрасываются. Это упрощает код и не вредит — юзер не видит «осиротевшие» записи, потому что match идёт по `keyOf` свежей строки.

### `MainPage.tsx`

В обработчик Send врезается preflight:

```ts
async function handleSend() {
  const [proxies, health] = await Promise.all([
    api.get<Proxy[]>('/api/proxies'),
    api.get<ProxyHealthResponse>('/api/proxies/health'),
  ]);
  const byKey = Object.fromEntries((health?.entries ?? []).map(e => [e.key, e]));
  const dead = (proxies ?? []).filter(p => byKey[keyOf(p)]?.ok === false).length;
  if (dead > 0) {
    const ok = window.confirm(`${dead} прокси помечены как мёртвые — аккаунты на них могут упасть. Продолжить?`);
    if (!ok) return;
  }
  // существующий код запуска: POST /api/send
}
```

Никакого нового state-менеджмента, никакого dialog-компонента — нативный `window.confirm`.

### `proxyKey.ts`

```ts
export const keyOf = (p: Pick<Proxy, 'host' | 'port' | 'username' | 'password'>) =>
  `${p.host}:${p.port}|${p.username ?? ''}|${p.password ?? ''}`;
```

### `error-labels.ts`

Все классы, которые возвращает `checkOne`, уже есть в `ERROR_LABELS`:
- `timeout`, `proxy_unreachable`, `proxy_auth_failed`, `twitch_unreachable`, `unknown` — присутствуют.

Одно мелкое исправление: текущий лейбл `timeout: 'Превышено время ожидания (15 сек)'` хардкодит таймаут `sendOne`. Теперь у нас два разных таймаута (15 сек у `sendOne`, 5 сек у health-чека), и упоминание «15 сек» вводит в заблуждение, если падает health-чек. Меняем на генеричный `timeout: 'Превышено время ожидания'`. Текущий UX `sendOne` от этого не страдает — фактическая длительность всё равно видна в колонке `Duration` таблицы прогресса.

## 10. Конкурентность

| Сценарий | Поведение |
|----------|-----------|
| Двойной клик «Check all» | Второй запрос → `409 check_running`, toast. UI-кнопки disabled во время чека. |
| «Check» во время `/send` | Разрешено. Health-чек и реальная отправка идут параллельно. |
| `/send` во время чека | Разрешено. `sender.isRunning()` и health-lock — независимые гейты. |
| Редактирование прокси во время чека | Результат записывается под старым `keyOf` → не сматчится с новой строкой → не вреден. |
| Удаление прокси во время чека | То же: результат «осиротеет» в map'е. |

## 11. Тестирование

**`test/proxyHealth.test.js`** — юнит-тесты `checkOne`/`checkMany` через подменённый `transport`:

- `checkOne` ok: транспорт резолвит сокет → `{ ok: true, latencyMs }`, сокет `destroy()` вызван
- `checkOne` timeout: транспорт не резолвится → `{ ok: false, error: 'timeout' }` после `timeoutMs`
- `checkOne` proxy_unreachable: реджект с `ECONNREFUSED`/`ETIMEDOUT`/`EHOSTUNREACH`/`ENOTFOUND` → `error: 'proxy_unreachable'`
- `checkOne` proxy_auth_failed: реджект с SOCKS auth error → `error: 'proxy_auth_failed'`
- `checkOne` twitch_unreachable: реджект с SOCKS «Host unreachable» reply → `error: 'twitch_unreachable'`
- `checkOne` unknown: любая прочая ошибка → `error: 'unknown'`, `details` присутствует
- `checkMany`: параллельный запуск, порядок результата = порядок входа

**`test/healthStore.test.js`**:

- `set` → `get` возвращает запись
- `get` несуществующего ключа → `null`
- `getDeadCount` считает только `ok === false`, не `null`, не `ok === true`
- `getEntriesFor` сохраняет порядок входа, `null` для отсутствующих
- `getAll` возвращает массив всех записей с `key`

**`test/api.proxies.check.test.js`** (через `supertest`, с фейковым `checkOne`):

- `POST /api/proxies/check` без body → чек всех, `results.length === proxies.length`, store обновлён
- `POST` с `{ indices: [0, 2] }` → чек только этих, `results.length === 2`, неупомянутые не трогаются
- `POST` с невалидными `indices` (out of range, не массив, не целые) → `400 invalid_indices`
- Двойной POST подряд (второй пока первый в полёте) → `409 check_running`
- `GET /api/proxies/health` → дамп всех записей
- `GET /api/proxies/health` без auth-cookie → `401` (переиспользует существующий тест-паттерн)

**Покрытие:** ~7 проверок в `proxyHealth.test.js`, ~5 в `healthStore.test.js`, ~6 в `api.proxies.check.test.js`. Итого ~18 новых тестов к текущему набору (`npm test` должен оставаться зелёным).

**Не покрывается тестами:**
- `socks` пакет — это upstream-код
- Реальные подключения к Twitch — не делаются в тестах (как и в `twitch.test.js`)
- Фронтовый UI — в проекте нет фронтовых тестов, в этом PR не заводим прецедент
- Ручной smoke-test добавится пунктом в `docs/next-steps.md`

## 12. Вне scope

Намеренно **не** делаем:
- Background-периодический recheck (юзер выбрал чисто on-demand)
- Persistent health в `proxies.json` или отдельном файле (юзер выбрал in-memory)
- Авто-skip/redistribute мёртвых прокси в `assignProxy` (юзер выбрал warn-but-proceed)
- Health-индикатор где-либо, кроме `/proxies` (на `MainPage` только confirm, без бэйджей)
- Health-history (только «последняя проверка», не серия)
- Cancel в полёте через AbortController (один шот — один результат)
- Per-account preflight на `MainPage` (вычисление, какие именно аккаунты могут упасть) — даём только общий счётчик dead-проксей
- shadcn `<Dialog>` для confirm (нативный `window.confirm` достаточен)

## 13. Открытые вопросы

Нет. Все развилки закрыты в брейншторме.
