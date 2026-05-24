import { layout } from './layout.js';
export function proxiesPage() {
  const body = `
<h1>Proxies (SOCKS5)</h1>
<p>Format on import: <code>host:port</code> or <code>host:port:user:pass</code> per line.</p>
<table id="proxies-table"><thead><tr><th>Host</th><th>Port</th><th>User</th><th>Pass</th><th></th></tr></thead><tbody></tbody></table>
<button id="add-row">+ Row</button>
<textarea id="bulk-import" placeholder="Paste lines here"></textarea>
<button id="import-bulk">Import</button>
<button id="save">Save</button>
<p id="status"></p>`;
  return layout({ title: 'Proxies', body, active: '/proxies' });
}