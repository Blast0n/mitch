import { layout } from './layout.js';
export function accountsPage() {
  const body = `
<h1>Accounts</h1>
<p>Supported import formats (one per line):<br>
&bull; <code>login&lt;TAB&gt;oauth:token</code><br>
&bull; <code>login:password:token:userid:date</code> (combo list)<br>
Token is auto-prefixed with <code>oauth:</code> if missing.</p>
<table id="accounts-table"><thead><tr><th>Login</th><th>Token</th><th></th></tr></thead><tbody></tbody></table>
<button id="add-row">+ Row</button>
<textarea id="bulk-import" placeholder="Paste accounts here (TSV or combo-list format)"></textarea>
<button id="import-bulk">Import</button>
<button id="save">Save</button>
<p id="status"></p>`;
  return layout({ title: 'Accounts', body, active: '/accounts' });
}