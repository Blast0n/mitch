# Stop bulk + Shuffle order — Design

**Дата:** 2026-05-31
**Статус:** Утверждено к реализации
**Связанные документы:**
- [`2026-05-24-twitch-multi-sender-design.md`](2026-05-24-twitch-multi-sender-design.md) (базовая система, `sender.js`)
- [`2026-05-25-quick-send-design.md`](2026-05-25-quick-send-design.md) (quick-send endpoint)

## 1. Цель

Две независимые правки поведения bulk-рассылки:

1. **Прерываемость.** Quick send (директ от одного аккаунта) больше не блокируется идущим bulk-джобом. Нажатие Quick send **автоматически останавливает** bulk (отменяет ещё не отправленные аккаунты), затем шлёт директ. Дополнительно — ручная кнопка **Stop** для bulk.
2. **Рандомный порядок.** Каждый bulk-запуск отправляет аккаунты в **случайном порядке** (Fisher–Yates), а не в порядке хранения. Привязка аккаунт→прокси (IP) при этом **не меняется**.

## 2. Текущее поведение (контекст)

- `routes/api.js` `POST /api/quick-send` возвращает `409 { error: 'bulk_running' }`, пока `sender.isRunning()`. Фронт (`QuickSend.tsx`) к тому же дизейблит поля по `disabled={isRunning}`.
- `sender.js` `start()` итерирует `accounts.map((account, i) => …)` строго в порядке хранения, `delay = i * interval`. Отмены джоба нет вообще.
- `assignProxy(i, proxies, accountsPerProxy)` группирует прокси по индексу аккаунта → один IP на аккаунт. Так же работают quick-send и follows.

## 3. Функциональные требования

1. Нажатие Quick send во время идущего bulk → bulk останавливается, директ отправляется. Никакого `409 bulk_running`.
2. Ручная кнопка Stop рядом с Send, видима только пока джоб идёт. Останавливает bulk без отправки директа.
3. «Остановка» отменяет только аккаунты, которые ещё **не начали** отправку. In-flight отправки (уже вызван `sendOne`) завершаются естественно и попадают в результаты как обычно.
4. Отменённые аккаунты получают статус `stopped` (не `failed`/ошибка).
5. После остановки джоб переходит в статус `'stopped'`, эмитит финальный `done`-event, SSE-поток закрывается, UI разблокируется.
6. Каждый bulk-запуск тасует порядок отправки случайно (Fisher–Yates). Привязка аккаунт→прокси неизменна: `assignProxy` зовётся по исходному индексу аккаунта в `accounts.json`; рандомизируется только очередь и тайминг (`delay`).
7. Рандом **всегда включён** — без настройки-тоггла.

## 4. Нефункциональные требования

- Никаких новых runtime-зависимостей.
- Вариант реализации отмены — **флаг `cancelled` + отслеживание таймеров** (не AbortController; in-flight WSS не обрывается).
- `settings.json` формат не меняется (рандом не конфигурируется).
- `twitch.js`, `store.js`, `proxyHealth.js`, `healthStore.js`, follows-модули — не тронуты.
- `assignProxy` сигнатура и поведение не меняются.

## 5. Бэкенд

### 5.1 `sender.js`

**Чистая функция `shuffle(arr, rng = Math.random)`** — Fisher–Yates, возвращает новый массив-перестановку. Экспортируется для теста. `createSender({ sendOne, rng })` принимает инъекцию `rng` (дефолт `Math.random`) и прокидывает её в `shuffle`.

**Структура джоба** дополняется:
- `cancelled: boolean` (init `false`)
- `pendingTasks: Set<{ timer, resolve, account, proxyLabel }>` — по записи на каждую ещё не стартовавшую задачу
- `status` получает новое значение `'stopped'` (наряду с `'running'` / `'done'`)

**Рандомизация в `start()`:**

```js
const order = shuffle(accounts.map((_, i) => i), rng); // перестановка индексов
const tasks = order.map((accIdx, pos) => {
  const account = accounts[accIdx];
  const proxy = assignProxy(accIdx, proxies, settings.accountsPerProxy); // по ИСХОДНОМУ индексу
  const delay = pos * interval;                                          // тайминг по позиции
  return new Promise((resolve) => {
    const task = { timer: null, resolve, account, proxyLabel };
    task.timer = setTimeout(() => {
      job.pendingTasks.delete(task);
      if (job.cancelled) return markStopped(task);       // общий хелпер, см. ниже
      limit(async () => { /* как сейчас: sending → sendOne → progress */ }).then(resolve, resolve);
    }, delay);
    job.pendingTasks.add(task);
  });
});
```

**`interval`** считается как сейчас: `(spreadSeconds * 1000) / max(1, accounts.length)`.

**Хелпер `markStopped(task)`** (идемпотентен — guard от гонки таймер vs stop):
```js
function markStopped(task) {
  if (task.done) return;            // guard
  task.done = true;
  job.results.push({ login: task.account.login, proxy: task.proxyLabel, ok: false, stopped: true });
  emit(jobId, { type: 'progress', login: task.account.login, proxy: task.proxyLabel, result: { ok: false, stopped: true } });
  task.resolve();
}
```

**Новый метод `stop(jobId)`:**
- если `!currentJob || currentJob.jobId !== jobId || currentJob.status !== 'running'` → `return false`;
- `job.cancelled = true`; `job.status = 'stopped'`;
- для каждой `task` из `job.pendingTasks`: `clearTimeout(task.timer); markStopped(task);` затем `job.pendingTasks.clear();`
- `return true`.

In-flight задачи (уже внутри `pLimit`) дорезолвиваются естественно и попадают в результаты как обычно. Ещё не стартовавшие задачи завершаются через `markStopped` — их `sendOne` не вызывается. `markStopped` идемпотентен, поэтому гонка «таймер сработал ровно в момент `stop()`» не задваивает запись.

**`Promise.all(tasks)`** дорезолвивается → эмитит финальный `done`. `summary` становится `{ total, ok, failed, stopped }`:
```js
const ok = job.results.filter(r => r.ok).length;
const stopped = job.results.filter(r => r.stopped).length;
const failed = job.results.length - ok - stopped;
const summary = { total: accounts.length, ok, failed, stopped };
```

`isRunning()` остаётся `currentJob?.status === 'running'` → после `stop()` вернёт `false`.

### 5.2 `routes/api.js`

**`POST /api/quick-send`** — заменяем блокировку на остановку:
- убрать оба `if (sender.isRunning()) return 409 bulk_running`;
- в начале хендлера: `if (sender.isRunning()) sender.stop(sender.lastJobId());`
- далее — без изменений (резолв аккаунта, прокси, `sendOne`).
- (in-flight аккаунты bulk могут успеть дослать — принятая оговорка.)

**Новый `POST /api/send/stop`:**
```js
r.post('/send/stop', (req, res) => {
  const id = sender.lastJobId();
  const ok = id ? sender.stop(id) : false;
  if (ok) return res.json({ stopped: true, jobId: id });
  return res.status(409).json({ error: 'not_running' });
});
```

## 6. Фронтенд

### `frontend/src/pages/MainPage.tsx`
- `<QuickSend disabled={false} … />` — quick send всегда доступен.
- Кнопка **Stop** рядом с `Send`, видима только при `isRunning`. Клик → `POST /api/send/stop`; `200` → лог «остановлено вручную»; `409 not_running` → тихо игнор.
- `deriveRows`: `result.stopped === true` → статус строки `'stopped'`, `kind: 'stopped'` (нейтральный). Счётчик `counts.stopped`. Лог по `done` показывает `ok/total, failed, stopped`.

### `frontend/src/components/QuickSend.tsx`
- Убрать заглушку «Жди завершения bulk-send» (поля больше не дизейблятся по bulk). Прочая логика без изменений.

### `frontend/src/components/ProgressTable.tsx`
- Рендер `kind: 'stopped'` — нейтральный серый бейдж «Остановлен».

### `frontend/src/components/JobStats.tsx`
- Добавить отображение счётчика `stopped`.

### `frontend/src/lib/error-labels.ts`
- `stopped: 'Остановлен'`, `not_running: 'Рассылка не идёт'`.

### `frontend/src/lib/api.ts`
- `JobEvent` progress `result` — опц. `stopped?: boolean`.
- `summary` — `stopped: number`.
- Новый `StopResponse = { stopped: true; jobId: string }`.

## 7. Тесты

### `test/sender.test.js` (дополняем)
- `shuffle(arr, rng)`: результат — перестановка (тот же мультисет элементов); детерминирован при фиксированном `rng`; вход не мутируется.
- Рандом порядка: при инъекции `rng` фактический порядок вызовов `sendOne` отличается от порядка хранения, но `assignProxy`/прокси на каждый аккаунт совпадает с привязкой по исходному индексу.
- `stop()`: отменяет ещё не стартовавшие задачи (их `sendOne` не вызывается), in-flight (через подменённый `sendOne` с `deferred`) дорезолвиваются, финальный `done` содержит `summary.stopped > 0`.
- `stop()` на чужом/завершённом `jobId` → `false`; на текущем running → `true`.
- Отменённые аккаунты эмитят `progress` с `result.stopped === true`; запись `stopped` идемпотентна (не задваивается при гонке таймер vs stop).

### `test/api.test.js` (дополняем)
- `POST /api/quick-send` во время идущего bulk → `sender.stop` вызван (bulk останавливается), директ уходит `200` (вместо прежнего `409 bulk_running`).
- `POST /api/send/stop` при идущем джобе → `200 { stopped: true }`.
- `POST /api/send/stop` без джоба / после завершения → `409 not_running`.

### Не покрывается тестами
- Обрыв реальных in-flight WSS-отправок (физически не делаем).
- Фронтовый UI (в проекте нет фронт-тестов — прецедент не заводим).
- Ручной smoke-test — пункт в `docs/next-steps.md`.

## 8. Вне scope

- **Обрыв in-flight отправок** (AbortController, вариант B) — намеренно нет; in-flight завершается естественно.
- **Настройка-тоггл рандома** — рандом всегда вкл.
- **Изменение `assignProxy` / группировки прокси** — привязка аккаунт→прокси неизменна.
- **Pause/resume** джоба — только полная остановка.

## 9. Открытые вопросы

Нет. Все развилки закрыты в брейншторме.
