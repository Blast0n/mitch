import { layout } from './layout.js';
export function accountsPage() {
  const body = `
<h1>Accounts</h1>
<p>Format on import: <code>login<TAB>oauth:token</code> per line.</p>
<table id="accounts-table"><thead><tr><th>Login</th><th>Token</th><th></th></tr></thead><tbody></tbody></table>
<button id="add-row">+ Row</button>
<textarea id="bulk-import" placeholder="Paste TSV here (login<TAB>oauth:token per line)"></textarea>
<button id="import-bulk">Import</button>
<button id="save">Save</button>
<p id="status"></p>`;
  return layout({ title: 'Accounts', body, active: '/accounts' });
}