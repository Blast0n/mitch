# Next Steps

Что осталось сделать. Возвращайся сюда, когда продолжишь.

## Текущее состояние

- ✅ Весь код реализован и слит в `main`
- ✅ 51/51 тестов проходят (`npm test`)
- ✅ Сервер стартует локально, login/auth работает (проверено curl-ом)
- ✅ Запушено на GitHub: https://github.com/Blast0n/mitch
- ⏳ Реальный smoke-test с Twitch ещё не проводился
- ⏳ VPS-деплой ещё не делался

Документация:
- Дизайн: `docs/superpowers/specs/2026-05-24-twitch-multi-sender-design.md`
- План реализации: `docs/superpowers/plans/2026-05-24-twitch-multi-sender.md`
- Деплой: `README.md`, `Caddyfile.example`, `systemd/twitch-sender.service`

---

## Шаг 1. Локальный smoke-test с реальным Twitch-аккаунтом (без прокси)

Цель: убедиться, что код реально шлёт сообщение в чат.

1. Создай или возьми тестовый Twitch-аккаунт + тестовый канал, который ты контролируешь.
2. Получи OAuth-токен с правом `chat:edit`:
   - https://twitchtokengenerator.com → Custom Scope → отметь `chat:edit` → Generate
   - Скопируй полученный токен в виде `oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
3. Запусти локально:
   ```bash
   npm start
   ```
4. Открой http://127.0.0.1:3000/login, залогинься.
5. На странице `/accounts`: добавь строку — `login = <ник>`, `oauthToken = oauth:...`. Сохрани.
6. На странице `/settings`: укажи `channel = <твой_канал>`, `word = test`. Сохрани.
7. На странице `/` нажми **Send**.

**Ожидаемый результат:** в течение ~1 сек в таблице прогресса появится `ok`, и в чате `<твой_канал>` должно появиться сообщение `test` от ник-аккаунта.

**Если упало:**
- `token_invalid` → токен протух или не имеет `chat:edit` (перегенерируй)
- `chat_blocked` → аккаунт забанен в канале / в чате включён follower-only mode
- `twitch_unreachable` → проблема с сетью / WebSocket
- `timeout` → что-то зависло, посмотри `journalctl` / stdout

---

## Шаг 2. Локальный smoke-test через SOCKS5

Цель: убедиться, что прокси корректно подключаются и не ломают отправку.

1. Раздобудь рабочий SOCKS5 прокси (платный сервис или бесплатный для теста).
2. На `/proxies` добавь его: `host`, `port`, опционально `username`/`password`. Сохрани.
3. На `/settings` оставь `accountsPerProxy = 5` (один прокси на текущий 1 аккаунт — норма).
4. Нажми **Send**.

**Ожидаемо:** статус `ok`, в колонке `Proxy` строка `host:port` (не `direct`). Сообщение приходит в чат.

**Если упало:**
- `proxy_unreachable` → прокси дохлый или host:port неверный
- `proxy_auth_failed` → пароль/логин прокси неверный (но SOCKS5 у нас классифицирует это в `proxy_unreachable` — смотри `details`)
- Долгий timeout → прокси очень медленный, увеличь `overallTimeoutMs` если нужно (сейчас 15 сек хардкод в `twitch.js`)

---

## Шаг 3. Полный sanity-check на 5 аккаунтах

1. Добавь все 5 аккаунтов + хотя бы 1 рабочий прокси.
2. На `/settings` — `spreadSeconds = 30` (растянуть на 30 сек, выглядит естественнее).
3. **Send** — наблюдай прогресс. Все 5 должны дойти.
4. Попробуй один токен сделать заведомо невалидным (поломай 1 символ) — проверь, что:
   - Этот аккаунт фейлится с `token_invalid`
   - Остальные 4 — `ok`
   - Появляется кнопка **Retry failed**
   - Retry перезапускает только упавший

---

## Шаг 3.5. Health-check прокси (новая фича)

Цель: убедиться, что кнопка проверки и pre-send confirm работают.

1. На `/proxies` добавь хотя бы один заведомо мёртвый прокси (например `127.0.0.1:1`) и один рабочий.
2. Нажми **Check all**.
3. **Ожидаемо:** через ~1–5 сек у живого — зелёный бэйдж `✓ Nms`, у мёртвого — красный `× <текст>`. Под бэйджем — относительное время.
4. Кликни **Activity-иконку** в строке живого прокси — обновится только её `checkedAt`.
5. Перейди на `/`, нажми **Send** — должно появиться `confirm("N прокси помечены как мёртвые…")`. Отмена → ничего не отправляется. ОК → bulk-send идёт как обычно.
6. Если все прокси здоровые — Send идёт без подтверждения.

---

## Шаг 3.6. Stop bulk + рандомный порядок (новая фича)

- С ≥3 аккаунтами и `spreadSeconds > 0` нажми **Send**. Убедись, что аккаунты уходят в *разном* порядке между двумя запусками (рандом).
- В середине запуска нажми **Stop**: оставшиеся аккаунты получают нейтральный бэйдж «остановлен»; джоб завершается со счётчиком `Stopped` в JobStats; страница разблокируется.
- В середине запуска вместо этого воспользуйся **Quick send** для одного аккаунта: bulk останавливается автоматически, а директ уходит.
- Каждый аккаунт всегда использует один и тот же прокси независимо от порядка запуска (проверь колонку Proxy).

---

## Шаг 4. VPS-деплой

Полная инструкция в `README.md` → секция `## VPS deploy`. Краткое резюме:

```bash
# На VPS под root
useradd -m tms
mkdir -p /opt/twitch-sender && chown tms:tms /opt/twitch-sender

# Под tms
su - tms
cd /opt/twitch-sender
git clone https://github.com/Blast0n/mitch.git .
npm ci --omit=dev

# Сгенерь секреты
npm run hash -- 'твой_пароль'        # → APP_PASSWORD_HASH
openssl rand -hex 32                  # → SESSION_SECRET

# Заполни .env
cp .env.example .env
nano .env
# Добавь:
#   APP_PASSWORD_HASH=$2b$12$...
#   SESSION_SECRET=...
#   PUBLIC_ORIGIN=https://yourdomain.example.com
#   PORT=3000
#   COOKIE_DAYS=7

# systemd
sudo cp systemd/twitch-sender.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now twitch-sender
sudo systemctl status twitch-sender   # должен быть active (running)

# Caddy (TLS)
sudo apt install caddy
sudo cp Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # замени yourdomain.example.com на свой
sudo systemctl reload caddy
```

После этого открываем `https://yourdomain.example.com/login` и повторяем шаги 1–3 уже на проде.

---

## Шаг 5. Tag релиза (опционально)

Когда всё подтверждено:

```bash
git tag v0.1.0
git push origin v0.1.0
```

---

## Полезные команды

```bash
# Локально
npm start                  # запустить сервер на :3000
npm test                   # все 51 тест
npm test -- --test-name-pattern="sendOne"   # один кластер
npm run hash -- somepw     # bcrypt-хэш пароля

# На VPS
journalctl -u twitch-sender -f     # логи в реальном времени
systemctl restart twitch-sender    # перезапустить после правок
systemctl restart caddy
```

---

## Известные ограничения (намеренно вне scope)

Эти штуки **не сделаны** и переносятся на будущие версии:

- ❌ Авто-refresh OAuth-токенов — токены протухают, юзер сам перевыпускает и вставляет
- ❌ Авто-проверка живости прокси — мёртвые прокси узнаются только при отправке
- ❌ История прошлых рассылок — состояние job'а живёт только в памяти, не переживает рестарт
- ❌ Множественные пользователи — один пароль на весь сервис
- ❌ Discord/Telegram уведомления при ошибках
- ❌ Разные сообщения per-account — всегда одно общее слово из `settings.word`
- ❌ Upper-bound на `concurrency`/`spreadSeconds`/`accountsPerProxy` — теоретически юзер может выставить безумные числа и подвесить процесс (но он — единственный юзер)

Подробнее в спеке, секция 14 «Вне scope».

---

## Если что-то не работает

1. `npm test` локально — должны быть все 51 зелёных. Если нет, сначала фикси тесты.
2. Логи сервера → стектрейс → строчка → правка → коммит → деплой.
3. При вопросах по архитектуре — спека `docs/superpowers/specs/...`.
