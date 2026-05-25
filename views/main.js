import { layout } from './layout.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function mainPage({ settings, counts }) {
  const body = `
<h1>Send</h1>
<section class="summary">
  <div><strong>Channel:</strong> #${esc(settings.channel || '—')}</div>
  <div><strong>Word:</strong> ${esc(settings.word || '—')}</div>
  <div><strong>Accounts:</strong> ${counts.accounts}</div>
  <div><strong>Proxies:</strong> ${counts.proxies} (${settings.accountsPerProxy}/proxy)</div>
  <div><strong>Spread:</strong> ${settings.spreadSeconds}s</div>
  <div><strong>Concurrency:</strong> ${settings.concurrency}</div>
  <a href="/settings">Edit</a>
</section>
<button id="send-btn">Send</button>
<button id="retry-btn" hidden>Retry failed</button>
<section class="job-stats" id="job-stats" hidden>
  <span>Прошло: <strong id="elapsed">0s</strong></span>
  <span>ETA: <strong id="eta">—</strong></span>
  <span>Pending: <strong id="cnt-pending">0</strong></span>
  <span>Sending: <strong id="cnt-sending">0</strong></span>
  <span class="ok">OK: <strong id="cnt-ok">0</strong></span>
  <span class="error">Failed: <strong id="cnt-failed">0</strong></span>
</section>
<table id="progress"><thead><tr><th>Login</th><th>Status</th><th>Proxy</th><th>Duration</th><th>Error</th></tr></thead><tbody></tbody></table>
<p id="summary"></p>
<details id="log-details" open>
  <summary>Event log</summary>
  <pre id="event-log"></pre>
</details>`;
  return layout({ title: 'Send', body, active: '/' });
}
