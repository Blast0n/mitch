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
