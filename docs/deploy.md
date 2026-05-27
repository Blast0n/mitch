# Hetzner CX22 Deploy Guide

Полный гайд по деплою Twitch Multi-Sender на Hetzner Cloud CX22 (€4.5/мес) с пояснениями к каждому шагу. Раскрывает раздел «VPS deploy» из основного README.

## Шаг 0. Купить сервер и домен

1. На **hetzner.com → Cloud** создай проект, добавь Cloud Server: **CX22**, Ubuntu 24.04, регион Falkenstein / Helsinki / Nuremberg. €4.5/мес. SSH-ключ закинь при создании, иначе пароль root пришлют на почту.
2. Получаешь публичный IP, например `49.12.x.x`.
3. Купи домен (Namecheap, Porkbun, Cloudflare ~$10/год). В DNS-настройках добавь **A-запись** `tms.твойдомен.com → 49.12.x.x`. TTL 300, ждать 5-10 минут пока распространится.

## Шаг 1. Базовая настройка сервера (как root)

```bash
ssh root@49.12.x.x

apt update && apt upgrade -y
apt install -y curl git ufw

# Node.js 20 (LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Файервол — открываем только 22, 80, 443
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
```

## Шаг 2. Делаем пользователя и папку (шаг 1 из README)

```bash
useradd -m tms
mkdir -p /opt/twitch-sender
chown tms:tms /opt/twitch-sender
```

**Зачем:** не запускать Node.js от root. Если кто-то найдёт RCE-дыру, он получит права обычного юзера, а не root. `systemd` запустит сервис от `User=tms` (см. `systemd/twitch-sender.service` строка 7).

## Шаг 3. Клонируем код и собираем (шаг 2 из README)

```bash
su - tms
cd /opt/twitch-sender
git clone https://github.com/Blast0n/mitch.git .
npm ci
npm run build    # собирает React SPA в dist/
```

Готовим `.env`:

```bash
cp .env.example .env
nano .env
```

Заполни значения. Хеш пароля сгенери (на любой машине где есть Node):

```bash
npm run hash -- твой_пароль_здесь
```

SESSION_SECRET:

```bash
openssl rand -hex 32
```

Обязательно `PUBLIC_ORIGIN=https://tms.твойдомен.com`.

Защити `.env` и `data/`:

```bash
chmod 600 .env
mkdir -p data && chmod 700 data
exit   # выходим из юзера tms обратно в root
```

## Шаг 4. systemd-сервис (шаги 3-4 из README)

```bash
cp /opt/twitch-sender/systemd/twitch-sender.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now twitch-sender
systemctl status twitch-sender   # должно быть active (running)
```

**Что делает этот юнит** (`systemd/twitch-sender.service`):

- `Restart=on-failure` + `RestartSec=5` — упало → перезапуск через 5 сек
- `ProtectSystem=full`, `ProtectHome=true`, `NoNewPrivileges=true` — sandbox, процесс не может писать в `/usr`, `/boot`, `/home` и эскалировать привилегии
- `EnvironmentFile=/opt/twitch-sender/.env` — переменные из `.env` подхватятся в окружение
- `WantedBy=multi-user.target` — стартует при загрузке сервера

Логи смотреть так: `journalctl -u twitch-sender -f`

## Шаг 5. Caddy + HTTPS (шаг 5 из README)

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy

cp /opt/twitch-sender/Caddyfile.example /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile   # замени yourdomain.example.com на tms.твойдомен.com
systemctl reload caddy
```

**Что делает Caddy** (`Caddyfile.example`):

- Слушает 443, проксирует на `127.0.0.1:3000` где висит твой Node-сервер
- **Сам получает Let's Encrypt сертификат** и продлевает — никакого certbot не нужно
- Логи в `/var/log/caddy/twitch-sender.log`

## Шаг 6. Готово (шаг 6 из README)

Открой `https://tms.твойдомен.com` → страница логина → пароль из шага 3 → дальше как локально.

## Обновление кода

Когда пушнёшь новый коммит:

```bash
su - tms
cd /opt/twitch-sender
git pull
npm ci
npm run build
exit
systemctl restart twitch-sender
```

Можно завернуть в скрипт `/opt/twitch-sender/scripts/deploy.sh` и запускать одной командой.

## Что не покрыто в README, но стоит сделать

- **Бэкап `data/` и `.env`** — `rsync` раз в день на свою машину или в Hetzner Storage Box (€3/мес за 1TB)
- **fail2ban** для SSH: `apt install fail2ban` — защитит от bruteforce
- **Сменить SSH-порт** или отключить пароли (`PasswordAuthentication no` в `/etc/ssh/sshd_config`)
- **Hetzner Cloud Firewall** в дашборде — дублирует ufw, режет трафик ещё до сервера

## Если что-то отвалилось

```bash
# Статус и последние 50 строк логов
systemctl status twitch-sender
journalctl -u twitch-sender -n 50

# Caddy
systemctl status caddy
journalctl -u caddy -n 50

# Проверить что Node слушает 3000
ss -tlnp | grep 3000
```
