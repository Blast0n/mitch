# Follow via Headless Browser — Roadmap

**Дата:** 2026-05-28
**Статус:** Будущая итерация. Не начинать без `/brainstorming` сессии.

## Зачем это нужно

В ветке `feat/follows-management` сделана страница `/follows` с двумя секциями: список follow-каналов аккаунтов (read) и кнопка Follow streamer (write). Read-часть работает полностью. Write-часть **упёрлась в защиту Twitch**, которую обойти server-side не получилось — нужен headless-браузер.

Эта запись фиксирует **что узнали** и **что делать в следующей итерации**, чтобы не повторять путь с нуля.

## Что узнали в ходе эксперимента (ветка `feat/follows-management`)

Хронология попыток (см. коммиты на ветке `feat/follows-management`):

1. **Базовый GQL клиент** через `node:https` + SOCKS5. Read-операции (`UserLookup`, `FollowedChannels`) проходят без проблем. Write-mutation (`FollowUser`) возвращает пустой body без `data.followUser`.
2. **Диагностика raw response** (commit `2394718`) — обнаружили что Twitch отдаёт `errors[].extensions.code === "integrity-failed"`.
3. **Реализовали integrity-token flow** (commit `79a44a8`) — POST в `gql.twitch.tv/integrity` за PASETO-токеном, кэшируем per-account state с `Client-Session-Id` + `X-Device-Id`. Twitch возвращает HTTP 429, **но с валидным токеном в теле**.
4. **Принимаем 429-с-токеном как успех** (commit `f557002`) — обнаружили что Twitch принимает запрос к `/gql` с этим токеном, парсит его, **и отдельно отшивает с тем же `failed integrity check`** на бэкенде.
5. **Откатили integrity-флоу** (commit `2c78447`) — он добавлял +1 HTTPS round-trip к каждой операции и не помогал. Оставили диагностику.

**Вывод:** Twitch валидирует integrity-токены против дополнительных сигналов (IP-репутация, TLS-fingerprint Node.js, HTTP/2-fingerprint, отсутствие Cloudflare cookies). Сервер-сайд этот барьер не проходит независимо от того, насколько корректно подделать заголовки.

## Что точно НЕ помогло

| Попытка | Результат |
|---------|-----------|
| Корректные `Authorization` + `Client-Id` от web-клиента | Reads ok, mutation отшивается |
| Получение integrity-токена через `/integrity` | Токен получен, но `/gql` всё равно отвергает |
| Browser-like заголовки (`Origin`, `Referer`, `Sec-Fetch-*`, Chrome User-Agent) | Cloudflare не пускает Node-fingerprint |
| Стабильный `X-Device-Id` per аккаунт | Не достаточно, IP/TLS всё равно палевные |

## Что предположительно поможет (рекомендуемый путь)

**Headless Chrome через Puppeteer** + `puppeteer-extra-plugin-stealth`.

Мы не пытаемся «обмануть» бот-детект — мы и есть реальный браузер: настоящий TLS-handshake, HTTP/2-fingerprint, Cloudflare cookies, V8 крутит integrity-скрипты Twitch'а. Эта связка хорошо известна для именно такого use-case (массовый follow на Twitch).

## Архитектура (черновик)

```
[FollowsPage UI] ──POST /api/follows/follow──┐
                                              │
                             [routes/api.js] ──┤
                                              │
                             [follows.js]      │  ← без изменений (кэш, локи, валидация)
                                  │           │
                            ┌─────┴─────┐
                            │           │
                       [twitchGql.js]   [browserFollow.js]  ← НОВЫЙ
                       (для read)       (для write)
                                            │
                                            ▼
                                  [Pool of headless Chromes]
                                            │
                                            ▼
                                    [SOCKS5 proxy → twitch.tv]
```

`follows.js` остаётся как есть. `followStreamer` вызывает не `twitchGql.followUser`, а `browserFollow.run(streamerLogin, account, proxy)`. Read-операции остаются на GQL.

## Технические компоненты

### 1. Зависимости
- `puppeteer-extra` + `puppeteer-extra-plugin-stealth` — Chrome + анти-детект
- `proxy-chain` — прокладка для SOCKS5 с user/pass (Chrome нативно SOCKS5 auth не передаёт)
- Опционально: `puppeteer-core` + системный Chromium вместо bundled (экономия ~150MB)

### 2. Логин в Chrome
OAuth-токен из `accounts.json` инжектится как cookie перед навигацией:
```js
await page.setCookie(
  { name: 'auth-token', value: token.replace(/^oauth:/, ''), domain: '.twitch.tv', secure: true },
  // Возможно ещё несколько (twilight-user, unique_id) — определить эмпирически
);
```

### 3. Сам follow
Два варианта реализации:

**(a) Через DOM:**
```js
await page.goto(`https://www.twitch.tv/${streamerLogin}`);
await page.waitForSelector('[data-a-target="follow-button"]', { timeout: 10000 });
await page.click('[data-a-target="follow-button"]');
await page.waitForSelector('[data-a-target="unfollow-button"]', { timeout: 5000 });
```
Плюсы: проще. Минусы: селекторы могут меняться (fragility).

**(b) Через `page.evaluate()` + fetch:**
```js
await page.goto(`https://www.twitch.tv/${streamerLogin}`);  // загрузка для cookies
await page.evaluate(async (broadcasterId) => {
  return fetch('/gql', { method: 'POST', body: JSON.stringify({ ... }) });
}, broadcasterId);
```
Плюсы: меньше зависит от UI. Минусы: integrity-токен надо ловить из контекста страницы (он живёт в JS-памяти).

Решить в брейншторме.

### 4. Browser pool
- Холодный запуск Chrome ~2 сек, ~50–100 MB RAM
- Решение: пул из N inстансов (по числу аккаунтов или N=2 ротированных)
- Cookies live per-аккаунт через отдельные UserDataDir
- Закрытие по timeout / при сигнале shutdown

### 5. VPS deployment
Дополнительные системные либы для Chromium на Linux: `libnss3`, `libfontconfig1`, `libgconf-2-4`, `libatk-bridge2.0-0`, `libgtk-3-0`, `libasound2`, и ещё несколько. Запуск с `--no-sandbox` (т.к. `tms` — не root). Обновить `systemd/twitch-sender.service`: бамп `MemoryMax` (≥1G) и `LimitNOFILE`.

Альтернатива — Docker, но это новая сборочная зависимость.

### 6. Лимиты и анти-бан
- Twitch банит за слишком быстрый mass-follow
- Нужна рандомизированная пауза 3–10 сек между follow на одном аккаунте
- Капча: если Twitch её покажет — текущая операция фейлится, аккаунт временно out-of-game
- Сохранение per-аккаунт сессий между рестартами (UserDataDir на диск) — чтобы Twitch видел стабильный «браузер»

## Open questions для brainstorm

1. **DOM vs `page.evaluate`** — какой подход выбираем (см. выше)
2. **Browser pool size и стратегия** — один Chrome на аккаунт постоянно? On-demand с TTL? Singleton?
3. **Унифицировать с read** — может, всё follow-API через браузер? (Дорого, но единообразно.)
4. **Unfollow** — заодно? Это симметричная mutation, тоже упрётся в integrity.
5. **Анти-бан spacing** — захардкодить 3–10 сек, или вынести в `settings.json` рядом с `spreadSeconds`?
6. **Сохранять ли cookies между рестартами** — да (стабильнее), но усложняет deployment.
7. **Куда складывать profile dirs** — `data/browser-profiles/<login>/`, или systemd state dir, или tmp?
8. **Selector resilience** — каждый раз smoke-тестить вручную? Или какой-то auto-detection / fallback?

## Реалистичный объём работы

| Этап | Объём | Время |
|------|-------|-------|
| Brainstorming session | спек | 1 сессия |
| Writing-plans | 10–12 задач | следующая сессия |
| `browserFollow` core + pool | ~250 строк JS | 3–4 задачи |
| Интеграция с `follows.js` (Vetka feat/follows-management) | ~50 строк | 1 задача |
| `systemd` + `docs/deploy.md` обновление | ~30 строк | 1 задача |
| Smoke-тестирование + дебаг селекторов | ручное | 1–2 итерации |

**Итого:** реально работающий follow через ~неделю активной работы.

## С чего начинать в новой сессии

1. **Смерджить или ребейзнуть `feat/follows-management`** на актуальный main (там read-часть полностью рабочая, write-часть с диагностикой). Либо начать новую ветку и зачерри-пикнуть нужные коммиты.
2. **`/brainstorming` для browser-based follow** с этим документом как контекстом. Ответы на open questions выше.
3. **`writing-plans`** → новая ветка `feat/follows-browser` → имплементация.

## Связанные документы

- Спека текущей follows-фичи: `docs/superpowers/specs/2026-05-28-follows-management-design.md`
- План текущей follows-фичи: `docs/superpowers/plans/2026-05-28-follows-management.md`
- Ветка с read-частью и диагностикой: `feat/follows-management` (15+ коммитов, **не смержена**, ждёт browser-based интеграции)
