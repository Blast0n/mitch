import { layout } from './layout.js';
export function settingsPage() {
  const body = `
<h1>Settings</h1>
<form id="settings-form">
  <label>Channel <input name="channel" required></label>
  <label>Word <input name="word" required></label>
  <label>Accounts per proxy <input type="number" name="accountsPerProxy" min="1" value="5"></label>
  <label>Spread seconds <input type="number" name="spreadSeconds" min="0" value="0"></label>
  <label>Concurrency <input type="number" name="concurrency" min="1" value="5"></label>
  <button type="submit">Save</button>
</form>
<p id="status"></p>`;
  return layout({ title: 'Settings', body, active: '/settings' });
}