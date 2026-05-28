# Follows Management — Design

**Дата:** 2026-05-28
**Статус:** Утверждено к реализации
**Связанные документы:**
- [`2026-05-24-twitch-multi-sender-design.md`](2026-05-24-twitch-multi-sender-design.md) (базовая система)
- [`2026-05-28-proxy-health-check-design.md`](2026-05-28-proxy-health-check-design.md) (паттерн in-memory cache + SOCKS5)

## 1. Цель

Добавить новую страницу `/follows`, которая (а) показывает список follow-каналов каждого аккаунта и (б) даёт возможность сфолловить указанного стримера сразу с нескольких аккаунтов (с поштучным выбором или всеми сразу).

Twitch снёс публичное Helix API для создания follow в 2021. Используется приватный GQL endpoint `gql.twitch.tv/gql` с интегрированным web-клиент-id (`kimne78kx3ncx6brgo4mv6wki5h1ko`) — тот же, что использует сайт. Работает с существующими `chat:edit` OAuth-токенами, дополнительных scope'ов не нужно. ToS-серая зона ровно как и существующий чат-функционал.

## 2. Функциональные требования

1. На странице `/follows` две независимые секции: «Follow streamer» (форма-действие) сверху и «Account follows» (таблица аккаунтов) снизу.
2. **Форма Follow streamer:**
   - Поле ввода логина стримера (валидация: `/^[a-zA-Z0-9_]+$/`, непустое).
   - Multi-select по аккаунтам: чекбоксы на каждый аккаунт из `accounts.json` + «Select all» / «Select none».
   - Кнопка `Follow (N)` — активна когда стример валиден и выбран хотя бы один аккаунт. На время in-flight — disabled с текстом «Следую…».
   - После завершения: inline-таблица результатов с per-account статусами (`✓ follow` / `уже следит` / `× <ошибка>`).
3. **Таблица Account follows:**
   - Глобальная кнопка `Refresh all` (с индикацией in-flight).
   - Строка на каждый аккаунт из `accounts.json`.
   - Колонки: Login, Status (`N follows` / `× <error>` / `— never loaded`), «Last loaded» с относительным временем, Actions (`Refresh` иконка + `Expand` chevron).
   - При раскрытии строки — лениво фетчится `GET /api/follows/:login` и показывается прокручиваемый список follows (login + displayName + относительное `followedAt`).
4. **Все Twitch-запросы (resolve + fetch follows + follow mutation)** идут через SOCKS5-прокси, назначенный аккаунту через существующий `assignProxy(accountIndex, proxies, settings.accountsPerProxy)`.
5. **Concurrency:** два независимых лока на сервере — `refreshInFlight` и `followActionInFlight`. Они НЕ блокируют друг друга и НЕ блокируют bulk-send (`sender.isRunning()`).
6. **`broadcasterId` стримера резолвится один раз** на каждый follow-action (первым выбранным аккаунтом), затем фан-аут на остальные аккаунты с тем же ID.
7. **Per-account ошибки** в follow-action и refresh **не валят весь fan-out** — записываются в `results` и показываются в UI.
8. **Концурентный refresh / follow** запроса возвращает `409 { error: 'refresh_running' }` / `409 { error: 'follow_running' }` соответственно.
9. Локализация UI — русская (как остальной интерфейс).

## 3. Нефункциональные требования

- Cache follow-списков — **in-memory** в сервере, как `healthStore`. Никаких изменений в `data/` или дисковых файлах.
- Таймаут одной GQL операции — **10 сек** хардкод (длиннее `proxyHealth`'s 5 сек, потому что GQL TLS + GQL parsing).
- Пагинация follows: страницы по 100, hard cap **500** записей на аккаунт (5 страниц).
- Fan-out concurrency для refresh и follow-action — реиспользуется `settings.concurrency` из существующих настроек.
- Никаких новых runtime-зависимостей: `socks-proxy-agent` уже есть, GQL делается через встроенный `node:https`.
- Никаких новых OAuth scope'ов — GQL принимает `chat:edit` токены с интегрированным web client-id.

## 4. Архитектура

Зеркальная пара модулей по аналогии с существующей chat-логикой:

```
[chat]   twitch.js (low: WSS+IRC)      + sender.js (orchestration)
[follow] twitchGql.js (low: HTTPS+GQL) + follows.js (orchestration)
```

```
[FollowsPage]
    │
    ├─ GET /api/follows ───────► [api.js] ──► [followsService.getCacheMetadata]
    ├─ GET /api/follows/:login ► [api.js] ──► [followsService.listFollows]
    ├─ POST /api/follows/refresh ► [api.js] ─► [followsService.refreshAll] ─► [twitchGql.{resolveUserId,getFollowedChannels}]
    └─ POST /api/follows/follow ► [api.js] ──► [followsService.followStreamer] ► [twitchGql.{resolveUserId,followUser}]
                                                       │                              │
                                                       └─ assignProxy (from sender.js)│
                                                                                      ▼
                                                                              [SocksProxyAgent → gql.twitch.tv:443]
```

### Новые файлы

- `twitchGql.js` — pure GQL-клиент. Экспортирует `resolveUserId`, `getFollowedChannels`, `followUser`, классификатор `classifyGqlError`, и `defaultGqlTransport`. Транспорт инжектируется через `opts.transport`.
- `follows.js` — `createFollowsService({ store, twitchGql })`. Возвращает `{ listFollows, refreshAll, followStreamer, getCacheMetadata }`. Кэш и локи — внутреннее состояние сервиса.
- `test/twitchGql.test.js` — ~13 тестов с подменённым transport.
- `test/follows.test.js` — ~17 тестов с подменённым `twitchGql`.
- `test/api.follows.test.js` — ~16 supertest тестов.
- `frontend/src/pages/FollowsPage.tsx` — новая страница.
- `frontend/src/lib/time.ts` — хелпер `relativeTime` (вынесен из `ProxiesPage.tsx`, чтобы переиспользовать).

### Изменения в существующих файлах

- `routes/api.js` — 4 новых эндпоинта. Принимает `followsService` через DI.
- `server.js` — создаёт `followsService` и инжектит в `apiRouter`.
- `frontend/src/App.tsx` — добавить `<Route path="/follows" element={<FollowsPage />} />`.
- `frontend/src/components/Nav.tsx` — добавить пункт `Follows` между `Proxies` и `Settings`.
- `frontend/src/lib/api.ts` — добавить типы `Follow`, `FollowsCacheEntry`, `FollowsCacheMetadata`, `FollowsCacheResponse`, `RefreshResult`, `RefreshResponse`, `FollowActionResult`, `FollowActionResponse`.
- `frontend/src/lib/error-labels.ts` — добавить лейблы новых классов ошибок (см. §6).
- `frontend/src/pages/ProxiesPage.tsx` — перейти на импорт `relativeTime` из `frontend/src/lib/time.ts` (удалить inline-копию).

### Что НЕ меняется

- `twitch.js`, `sender.js`, `store.js`, `proxyHealth.js`, `healthStore.js` — не тронуты.
- `proxies.json`, `accounts.json`, `settings.json` — формат не меняется.
- `assignProxy` импортируется из `sender.js` как pure-функция.
- `package.json` — никаких новых deps.

## 5. `twitchGql.js` — низкий уровень

### Транспорт

Дефолт — `node:https` POST в `https://gql.twitch.tv/gql` через `SocksProxyAgent` (если задан `proxy`). Headers:
- `Authorization: OAuth <token>` (префикс `oauth:` снимается)
- `Client-Id: kimne78kx3ncx6brgo4mv6wki5h1ko`
- `Content-Type: application/json`

Body — `{ operationName, query, variables }`. Внешний таймаут — 10 сек через `Promise.race` с `setTimeout`.

Транспорт инжектируется через `opts.transport({ query, variables, token, proxy }) → { status, body }`. Тесты подменяют его целиком; код операций не знает про `socks-proxy-agent` напрямую.

### Операции

```js
// 1) Resolve streamer login → numeric user_id (string)
async function resolveUserId(login, { token, proxy, transport, timeoutMs } = {})

// 2) Fetch up to opts.limit (default 500) follows for accountUserId
async function getFollowedChannels(userId, { token, proxy, transport, limit, timeoutMs } = {})
// Returns: Follow[] = [{ userId, login, displayName, followedAt }]
// Internal pagination: страницы по 100 пока hasNextPage && total < limit

// 3) Follow target broadcaster
async function followUser(broadcasterId, { token, proxy, transport, timeoutMs } = {})
// Returns: { ok: true, alreadyFollowing: boolean }
// Throws GqlError on failure
```

### GQL queries (для имплементатора)

```graphql
# UserLookup
query UserLookup($login: String!) {
  user(login: $login) { id }
}

# FollowedChannels
query FollowedChannels($id: ID!, $first: Int!, $after: Cursor) {
  user(id: $id) {
    follows(first: $first, after: $after) {
      edges { followedAt, node { id, login, displayName } }
      pageInfo { hasNextPage }
    }
  }
}

# FollowUser
mutation FollowUser($input: FollowUserInput!) {
  followUser(input: $input) {
    follow { followedAt }
    error { code }
  }
}
# input variables: { targetID: <id>, disableNotifications: true }
```

## 6. Классификация ошибок

`GqlError extends Error` с полем `.class`. Возможные классы:

| Класс | Источник |
|-------|----------|
| `token_invalid` | HTTP 401 OR GQL `errors[].extensions.code === 'service-error'` с auth-маркером |
| `streamer_not_found` | GQL `data.user === null` в `UserLookup` OR `errors[].extensions.code === 'TARGET_USER_NOT_FOUND'` OR `data.followUser.error.code === 'TARGET_USER_NOT_FOUND'` |
| `already_following` | `data.followUser.error.code === 'ALREADY_FOLLOWING'` (НЕ throw — возвращается как `{ ok: true, alreadyFollowing: true }`) |
| `rate_limited` | HTTP 429 OR `errors[].extensions.code === 'service-rate-limit-exceeded'` |
| `proxy_unreachable` | Socket-level `ECONNREFUSED` / `ETIMEDOUT` / `EHOSTUNREACH` / `ENOTFOUND` / `ENETUNREACH` |
| `twitch_unreachable` | HTTP 5xx OR SOCKS reply «Host unreachable» |
| `timeout` | Внутренний `setTimeout(timeoutMs)` истёк |
| `unknown` | Всё прочее (fallback с `details: err.message`) |

`already_following` — особый: НЕ ошибка, возвращается через позитивный путь `{ ok: true, alreadyFollowing: true }`. Это user-meaningful info, не failure.

## 7. `follows.js` — оркестрация и кэш

### Кэш

```js
// Map<accountLogin (lowercased), {
//   follows: Follow[],
//   fetchedAt: number,
//   error?: string,
//   details?: string
// }>
```

Ключ — `account.login.toLowerCase()`. При удалении аккаунта запись «осиротеет» (UI не покажет), при добавлении — кэш-промах при первом обращении. Без TTL, без чистки. Восстанавливается при рестарте.

### API сервиса

```js
export function createFollowsService({ store, twitchGql }) {
  const cache = new Map();
  let refreshInFlight = false;
  let followActionInFlight = false;

  async function listFollows(login, { force = false } = {});
  async function refreshAll(logins?);                          // returns RefreshResult[]
  async function followStreamer(streamerLogin, accountLogins); // returns { broadcasterId, results }
  function getCacheMetadata();                                  // returns FollowsCacheMetadata[]

  return { listFollows, refreshAll, followStreamer, getCacheMetadata };
}
```

### Ключевые правила

- **`listFollows`** — cache miss или `entry.error` → refetch; иначе hit. `force: true` → всегда refetch.
- **`refreshOne`** (внутренний) — ошибка пишется в кэш с `error` (НЕ throw), чтобы UI показал per-account failure. Throw только если `login` не в `accounts.json`.
- **`refreshAll`** — concurrency через `p-limit(settings.concurrency || 5)`. Лок `refreshInFlight` обернут в try/finally.
- **`followStreamer`** — пайплайн:
  1. Валидация: каждый `accountLogin` должен быть в `accounts.json` → иначе throw `unknown_account`.
  2. `assignProxy` для каждого аккаунта по его индексу в `accounts.json` (НЕ по индексу в `accountLogins`).
  3. `resolveUserId(streamerLogin)` — ОДИН раз, первым выбранным аккаунтом (его токеном + его прокси). Если throws — весь method throws с тем же классом.
  4. `p-limit(settings.concurrency || 5)` для fan-out `followUser(broadcasterId, ...)` по аккаунтам.
  5. Per-account ошибки в `results`, не throws.
- **`assignProxy`** — импортируется из `sender.js`. Тот же индекс/группировка, что и для чата → Twitch видит один IP для всех действий аккаунта.
- **`broadcasterId`** НЕ кэшируется отдельно (мелкая оптимизация, YAGNI).
- **Локи** — два независимых, в try/finally. Не блокируют bulk-send.

### Что НЕ делает сервис

- Не реализует unfollow (out of scope, v1).
- Не валидирует формат `streamerLogin` (это работа API-слоя).
- Не обновляет кэш после follow-action автоматически (требует ещё round-trip; юзер сам жмёт refresh).
- Не fallback'ает на следующий аккаунт при провале резолва `broadcasterId` (простота важнее гибкости).

## 8. HTTP API

Все четыре эндпоинта под `app.use('/api', requireAuth, csrf, apiRouter(...))`.

### `GET /api/follows`

Метаданные кэша.

**Response 200:**
```json
{
  "cache": [
    { "login": "user1", "fetchedAt": 1748448000000, "count": 42, "error": null },
    { "login": "user2", "fetchedAt": 1748448100000, "count": 0, "error": "token_invalid" }
  ]
}
```

Пустой кэш → `{ "cache": [] }`. Аккаунты без записи в кэше в ответе отсутствуют.

### `GET /api/follows/:login`

Полный список follows одного аккаунта.

**Validation:** `:login` должен быть в `accounts.json` (lookup case-insensitive). Иначе `404 { error: 'unknown_account' }`.

**Response 200:**
```json
{
  "login": "user1",
  "follows": [
    { "userId": "12345", "login": "streamer1", "displayName": "Streamer One", "followedAt": "2024-01-15T10:30:00Z" }
  ],
  "fetchedAt": 1748448000000,
  "error": null
}
```

**`404 { error: 'not_cached' }`** — login валидный, но запись не в кэше (юзер ещё не нажимал Load/Refresh).

### `POST /api/follows/refresh`

Body: `{ logins?: string[] }`. Опущенный = все аккаунты.

**Validation:**
- Если `logins` есть: непустой массив строк, каждый — валидный login из `accounts.json`. Иначе `400 { error: 'invalid_logins' }`.

**Concurrency lock:** `refreshInFlight` → второй параллельный POST `409 { error: 'refresh_running' }`.

**Response 200:**
```json
{
  "results": [
    { "login": "user1", "ok": true, "count": 42, "fetchedAt": 1748448000000 },
    { "login": "user2", "ok": false, "error": "token_invalid", "fetchedAt": 1748448001000 }
  ]
}
```

Порядок результатов = порядок входа (или порядок `accounts.json` если `logins` опущен).

### `POST /api/follows/follow`

Body: `{ streamer: string, logins: string[] }`.

**Validation:**
- `streamer`: непустая строка, матчит `/^[a-zA-Z0-9_]+$/`. Иначе `400 { error: 'invalid_streamer' }`.
- `logins`: непустой массив строк, каждый — валидный login. Иначе `400 { error: 'invalid_logins' }`.

**Concurrency lock:** `followActionInFlight` → `409 { error: 'follow_running' }`.

**Response 200 (happy path):**
```json
{
  "broadcasterId": "987654",
  "results": [
    { "login": "user1", "ok": true, "alreadyFollowing": false },
    { "login": "user2", "ok": true, "alreadyFollowing": true },
    { "login": "user3", "ok": false, "error": "token_invalid", "details": "..." }
  ]
}
```

**Резолв-fail отдельные коды:**
- `streamer_not_found` при resolve → `400 { error: 'streamer_not_found' }`.
- Сетевая ошибка (`proxy_unreachable` / `twitch_unreachable` / `timeout` / `unknown`) при resolve → `502 { error: <class>, details: <err.message> }`.

В обоих случаях `followUser`-вызовы НЕ делаются.

## 9. Фронтенд

### Роутинг и навигация

- `frontend/src/App.tsx` — `<Route path="/follows" element={<FollowsPage />} />`.
- `frontend/src/components/Nav.tsx` — пункт `Follows` между `Proxies` и `Settings`.

### `FollowsPage.tsx`

Две карточки сверху-вниз: «Follow streamer» (форма) и «Account follows» (таблица).

**Состояние компонента:**

```ts
const [accounts, setAccounts] = useState<Account[]>([]);
const { meta, refresh: refreshMeta } = useFollowsCache();
const [streamer, setStreamer] = useState('');
const [selected, setSelected] = useState<Set<string>>(new Set());
const [following, setFollowing] = useState(false);
const [followResults, setFollowResults] = useState<FollowActionResult[] | null>(null);
const [refreshing, setRefreshing] = useState(false);
const [loadingPerAccount, setLoadingPerAccount] = useState<Record<string, boolean>>({});
const [expanded, setExpanded] = useState<Record<string, boolean>>({});
const [accountFollows, setAccountFollows] = useState<Record<string, Follow[]>>({});
```

**Хук `useFollowsCache`:**

```ts
function useFollowsCache() {
  const [meta, setMeta] = useState<Record<string, FollowsCacheMetadata>>({});
  const refresh = useCallback(async () => {
    const r = await api.get<FollowsCacheResponse>('/api/follows');
    if (r) setMeta(Object.fromEntries(r.cache.map(e => [e.login.toLowerCase(), e])));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { meta, refresh };
}
```

**Поведение:**
- Аккаунты тянутся через `GET /api/accounts` на mount.
- `isValidStreamer(s) === /^[a-zA-Z0-9_]+$/.test(s.trim())`.
- Кнопка Follow disabled когда `!isValidStreamer || selected.size === 0 || following`.
- `runFollow` — `POST /api/follows/follow` → on success → `setFollowResults(r.results)`. На `409 follow_running` → toast `follow_running`. На `400 invalid_streamer / invalid_logins` → toast. На `400 streamer_not_found` → toast `streamer_not_found`. На `502 <class>` → toast с лейблом класса.
- `runRefreshAll` — `POST /api/follows/refresh` без body → после ответа `refreshMeta()`. Per-row Refresh icon — `POST /api/follows/refresh` с `{ logins: [login] }` + spinner на этой строке.
- При первом раскрытии строки И отсутствии `accountFollows[login]` — лениво фетчим `GET /api/follows/:login` и кладём в `accountFollows`. На 404 `not_cached` — toast «список ещё не загружен, нажми Refresh».

### Хелпер `relativeTime` — выносим в `frontend/src/lib/time.ts`

Извлечь из текущего `frontend/src/pages/ProxiesPage.tsx` в общий модуль. ProxiesPage переходит на импорт.

### Новые ключи в `error-labels.ts`

```ts
streamer_not_found: 'Стример не найден',
already_following: 'Уже подписан',
rate_limited: 'Twitch: слишком много запросов',
refresh_running: 'Обновление уже идёт',
follow_running: 'Follow уже идёт',
not_cached: 'Список ещё не загружен',
invalid_streamer: 'Неверный логин стримера',
invalid_logins: 'Неверный список аккаунтов'
```

Остальные классы (`token_invalid`, `proxy_unreachable`, `twitch_unreachable`, `timeout`, `unknown`, `unknown_account`) уже есть.

## 10. Конкурентность

| Сценарий | Поведение |
|----------|-----------|
| Двойной `POST /api/follows/refresh` | Второй → `409 refresh_running` |
| Двойной `POST /api/follows/follow` | Второй → `409 follow_running` |
| Refresh + Follow параллельно | Разрешено (два разных лока) |
| Refresh + bulk-send параллельно | Разрешено (`sender.isRunning()` отдельный) |
| Follow + bulk-send параллельно | Разрешено |
| Refresh + `/proxies/check` параллельно | Разрешено |
| Удаление аккаунта во время refresh | Cache entry осиротеет, не вредна |
| Per-row Refresh во время global Refresh all | Per-row → 409 (общий лок) |

## 11. Тестирование

**`test/twitchGql.test.js`** (~13 тестов) — с подменённым `transport`:
- `resolveUserId`: ok, `streamer_not_found` (data.user === null), `token_invalid` (401), `proxy_unreachable` (ECONNREFUSED), `timeout`.
- `getFollowedChannels`: ok без пагинации, ok с пагинацией (transport вызван дважды, второй с `cursor`), упор в `limit: 500` после 5 страниц, обработка пустого списка.
- `followUser`: ok, `already_following`, `target_not_found` (через mutation error), `rate_limited` (429), `token_invalid`.
- Headers: token попадает в transport без префикса `oauth:`.

**`test/follows.test.js`** (~17 тестов) — с подменённым `twitchGql`:
- `listFollows`: cache miss → fetch + cache, cache hit → no refetch, `force: true` → refetch, errored entry → refetch, unknown account → throws.
- `refreshOne` ошибка пишется в кэш как `error` (не throws).
- `refreshAll`: все аккаунты vs указанные, 409 при повторном вызове, использует `p-limit`.
- `followStreamer`: happy path, использует `assignProxy` правильно (индекс аккаунта в `accounts.json`, не в `accountLogins`), `streamer_not_found` валит весь метод, per-account ошибки не валят fan-out, `unknown_account` throws до резолва, 409 при повторе.
- Refresh и Follow параллельно — оба идут.
- `getCacheMetadata` возвращает корректный формат.

**`test/api.follows.test.js`** (~16 тестов) — supertest:
- `GET /api/follows` пусто и с данными.
- `GET /api/follows/:login` 200, 404 `not_cached`, 404 `unknown_account`.
- `POST /api/follows/refresh` без body, с `logins`, 400 `invalid_logins`, 409 (через `.end(cb)` workaround как в health-check Task 5).
- `POST /api/follows/follow` happy, 400 `invalid_streamer`, 400 `invalid_logins`, 400 `streamer_not_found`, 502 на сетевую ошибку, 409.
- Refresh + Follow параллельно — оба 200.

**Итого ~46 новых тестов** к текущему набору (78 = 60 baseline + 18 health). Конечный набор: ~124.

**Не покрывается тестами:**
- Реальный `gql.twitch.tv` endpoint (схема upstream, не наш код).
- Реальные SOCKS-подключения (как и `proxyHealth`, `twitch.js`).
- Фронтовый UI — в проекте нет фронтовых тестов; не заводим прецедент в этом PR.
- Ручной smoke-test добавляется пунктом в `docs/next-steps.md`.

## 12. Вне scope

Намеренно **не** делаем в v1:
- **Unfollow** — симметричный flow. Полезен, но удваивает endpoint surface, UI и тесты. Отдельная итерация.
- **Поиск стримеров** (typeahead) — поле ввода simple text input, никакой автокомплит-подсказки по живым стримерам.
- **Кэш `broadcasterId`** для одного и того же стримера между follow-actions.
- **Persistent кэш** follow-списков на диск — in-memory как `healthStore`.
- **Background-периодический refresh** — только on-demand.
- **Per-account preflight на основе health-check'а прокси** — если у аккаунта дохлый прокси, узнаем при попытке follow.
- **Auto-refresh кэша после успешного follow-action** — юзер сам жмёт Refresh.
- **Cancel в полёте** через AbortController.
- **OAuth refresh-token flow** — токен дохлый → `token_invalid` в результатах, юзер сам перевыпускает.
- **Notifications-toggle при follow** — фолловим всегда с `disableNotifications: true`.
- **Pagination для UI follows-списка** — scrolling area shadcn ScrollArea (`h-[300px]`), без виртуализации.

## 13. Открытые вопросы

Нет. Все развилки закрыты в брейншторме.
