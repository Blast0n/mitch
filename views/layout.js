export function layout({ title, body, active }) {
  const link = (href, label) =>
    `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`;
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${title} — Twitch Sender</title>
<link rel="stylesheet" href="/style.css">
</head><body>
<nav>
  ${link('/', 'Send')}
  ${link('/accounts', 'Accounts')}
  ${link('/proxies', 'Proxies')}
  ${link('/settings', 'Settings')}
  <a href="/logout" class="right">Logout</a>
</nav>
<main>${body}</main>
<script src="/app.js"></script>
</body></html>`;
}