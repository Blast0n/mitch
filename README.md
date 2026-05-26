# Twitch Multi-Sender

Send one message from N Twitch accounts to a channel via SOCKS5 proxies.

## Local dev

```bash
npm install
npm run hash -- your-password    # paste into .env as APP_PASSWORD_HASH
openssl rand -hex 32             # paste into .env as SESSION_SECRET

# Option A — single-port dev (build SPA once, run Express)
npm run build
npm start
# open http://127.0.0.1:3000

# Option B — Vite hot-reload (two ports: SPA :5173 proxies API to Express :3000)
npm run dev
# open http://127.0.0.1:5173 — SPA reloads on file changes
```

## VPS deploy

1. `useradd -m tms && mkdir -p /opt/twitch-sender && chown tms:tms /opt/twitch-sender`
2. As `tms`: clone repo, `npm ci`, fill in `.env` (set `PUBLIC_ORIGIN=https://yourdomain.example.com`), run `npm run build` to compile the SPA into `dist/`
3. `cp systemd/twitch-sender.service /etc/systemd/system/` (edit user/path if needed)
4. `systemctl daemon-reload && systemctl enable --now twitch-sender`
5. Install Caddy, copy `Caddyfile.example` to `/etc/caddy/Caddyfile` (replace domain), `systemctl reload caddy`
6. Browse to your domain, log in, fill in accounts/proxies/settings, click Send.

## Notes

- Tokens (`chat:edit` scope) can be obtained via https://twitchtokengenerator.com or a custom OAuth flow.
- Twitch ToS forbids artificial chat activity — running this risks account bans. Use at your own discretion.
- Settings are stored unencrypted in `./data/*.json` (chmod 600 by the `tms` user). Take backups.
