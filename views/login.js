export function loginPage({ error } = {}) {
  return `<!doctype html><html><head>
<meta charset="utf-8"><title>Login</title>
<link rel="stylesheet" href="/style.css">
</head><body class="centered">
<form method="post" action="/login" class="login">
  <h1>Twitch Sender</h1>
  <input type="password" name="password" placeholder="Password" required autofocus>
  <button type="submit">Login</button>
  ${error ? `<p class="error">${error}</p>` : ''}
</form>
</body></html>`;
}