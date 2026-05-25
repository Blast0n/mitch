// Detect page by element presence
const $ = (sel) => document.querySelector(sel);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

function setStatus(text, ok = true) {
  const el = $('#status');
  if (el) { el.textContent = text; el.className = ok ? 'ok' : 'error'; }
}

// ===== Accounts page =====
if ($('#accounts-table')) {
  const tbody = $('#accounts-table tbody');
  const addRow = (a = { login: '', oauthToken: '' }) => {
    const tr = document.createElement('tr');
    const tdLogin = document.createElement('td');
    const inpLogin = document.createElement('input');
    inpLogin.className = 'login';
    inpLogin.value = a.login || '';
    tdLogin.appendChild(inpLogin);
    const tdTok = document.createElement('td');
    const inpTok = document.createElement('input');
    inpTok.className = 'token';
    inpTok.type = 'password';
    inpTok.value = a.oauthToken || '';
    tdTok.appendChild(inpTok);
    const tdDel = document.createElement('td');
    const btnDel = document.createElement('button');
    btnDel.className = 'del';
    btnDel.textContent = '×';
    btnDel.onclick = () => tr.remove();
    tdDel.appendChild(btnDel);
    tr.append(tdLogin, tdTok, tdDel);
    tbody.appendChild(tr);
  };
  api('GET', '/api/accounts').then(rows => (rows || []).forEach(addRow));
  $('#add-row').onclick = () => addRow();
  $('#import-bulk').onclick = () => {
    const lines = $('#bulk-import').value.split('\n').map(l => l.trim()).filter(Boolean);
    const RAW_TOKEN = /^[a-zA-Z0-9_-]{20,}$/;
    for (const line of lines) {
      let login, token;
      const colon = line.split(':');
      if (colon.length >= 3 && colon[0] && RAW_TOKEN.test(colon[2])) {
        // Combo-list format: login:pass:token:userid:date
        login = colon[0];
        token = colon[2].startsWith('oauth:') ? colon[2] : 'oauth:' + colon[2];
      } else {
        // TSV / space-separated: login<TAB>oauth:xxx
        const ws = line.split(/\s+/, 2);
        login = ws[0];
        token = ws[1] && (ws[1].startsWith('oauth:') ? ws[1] : 'oauth:' + ws[1]);
      }
      if (login && token) addRow({ login, oauthToken: token });
    }
    $('#bulk-import').value = '';
  };
  $('#save').onclick = async () => {
    const rows = Array.from(tbody.querySelectorAll('tr')).map(tr => ({
      login: tr.querySelector('.login').value.trim(),
      oauthToken: tr.querySelector('.token').value.trim()
    }));
    const res = await fetch('/api/accounts', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify(rows) });
    if (res.status === 204) setStatus('Saved', true);
    else { const e = await res.json(); setStatus('Errors: ' + e.errors.join('; '), false); }
  };
}

// ===== Proxies page =====
if ($('#proxies-table')) {
  const tbody = $('#proxies-table tbody');
  const addRow = (p = {}) => {
    const tr = document.createElement('tr');
    const mk = (cls, type, val) => {
      const td = document.createElement('td');
      const inp = document.createElement('input');
      inp.className = cls;
      if (type) inp.type = type;
      inp.value = val ?? '';
      td.appendChild(inp);
      return td;
    };
    const tdDel = document.createElement('td');
    const btnDel = document.createElement('button');
    btnDel.className = 'del';
    btnDel.textContent = '×';
    btnDel.onclick = () => tr.remove();
    tdDel.appendChild(btnDel);
    tr.append(
      mk('host', null, p.host),
      mk('port', 'number', p.port),
      mk('user', null, p.username),
      mk('pass', 'password', p.password),
      tdDel
    );
    tbody.appendChild(tr);
  };
  api('GET', '/api/proxies').then(rows => (rows || []).forEach(addRow));
  $('#add-row').onclick = () => addRow();
  $('#import-bulk').onclick = () => {
    const lines = $('#bulk-import').value.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length < 2) continue;
      addRow({ host: parts[0], port: Number(parts[1]), username: parts[2] || '', password: parts[3] || '' });
    }
    $('#bulk-import').value = '';
  };
  $('#save').onclick = async () => {
    const rows = Array.from(tbody.querySelectorAll('tr')).map(tr => {
      const o = {
        host: tr.querySelector('.host').value.trim(),
        port: Number(tr.querySelector('.port').value)
      };
      const u = tr.querySelector('.user').value.trim();
      const p = tr.querySelector('.pass').value;
      if (u) o.username = u;
      if (p) o.password = p;
      return o;
    });
    const res = await fetch('/api/proxies', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify(rows) });
    if (res.status === 204) setStatus('Saved', true);
    else { const e = await res.json(); setStatus('Errors: ' + e.errors.join('; '), false); }
  };
}

// ===== Settings page =====
if ($('#settings-form')) {
  const form = $('#settings-form');
  api('GET', '/api/settings').then(s => {
    if (!s) return;
    form.channel.value = s.channel;
    form.word.value = s.word;
    form.accountsPerProxy.value = s.accountsPerProxy;
    form.spreadSeconds.value = s.spreadSeconds;
    form.concurrency.value = s.concurrency;
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      channel: form.channel.value.trim(),
      word: form.word.value,
      accountsPerProxy: Number(form.accountsPerProxy.value),
      spreadSeconds: Number(form.spreadSeconds.value),
      concurrency: Number(form.concurrency.value)
    };
    const res = await fetch('/api/settings', { method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
    if (res.status === 204) setStatus('Saved', true);
    else { const e = await res.json(); setStatus('Errors: ' + e.errors.join('; '), false); }
  };
}

// ===== Main page =====
if ($('#send-btn')) {
  const btn = $('#send-btn');
  const retry = $('#retry-btn');
  const tbody = $('#progress tbody');
  const summary = $('#summary');
  const rowFor = (login) => {
    let tr = tbody.querySelector(`tr[data-login="${CSS.escape(login)}"]`);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.login = login;
      for (let i = 0; i < 5; i++) tr.appendChild(document.createElement('td'));
      tr.children[0].textContent = login;
      tr.children[1].textContent = 'pending';
      tr.children[2].textContent = '—';
      tr.children[3].textContent = '—';
      tbody.appendChild(tr);
    }
    return tr;
  };
  function attachSSE(jobId) {
    const es = new EventSource('/api/progress?jobId=' + encodeURIComponent(jobId));
    es.addEventListener('sending', (e) => {
      const { login, proxy } = JSON.parse(e.data);
      const tr = rowFor(login);
      tr.children[1].textContent = 'sending';
      tr.children[2].textContent = proxy;
    });
    es.addEventListener('progress', (e) => {
      const { login, proxy, result } = JSON.parse(e.data);
      const tr = rowFor(login);
      tr.children[1].textContent = result.ok ? 'ok' : 'failed';
      tr.children[1].className = result.ok ? 'ok' : 'error';
      tr.children[2].textContent = proxy;
      tr.children[3].textContent = (result.durationMs ?? '—') + 'ms';
      tr.children[4].textContent = result.error || '';
    });
    es.addEventListener('done', (e) => {
      const { summary: s } = JSON.parse(e.data);
      summary.textContent = `Done: ${s.ok}/${s.total} ok, ${s.failed} failed`;
      btn.disabled = false;
      if (s.failed > 0) retry.hidden = false;
      es.close();
    });
  }
  btn.onclick = async () => {
    btn.disabled = true;
    tbody.innerHTML = '';
    summary.textContent = '';
    retry.hidden = true;
    const r = await fetch('/api/send', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' });
    if (r.status === 202) {
      const { jobId } = await r.json();
      attachSSE(jobId);
    } else if (r.status === 409) {
      const body = await r.json();
      if (body.jobId) attachSSE(body.jobId);
      else { summary.textContent = 'A job is already running.'; btn.disabled = false; }
    } else {
      const body = await r.json().catch(() => ({}));
      summary.textContent = 'Error: ' + (body.error || r.status);
      btn.disabled = false;
    }
  };
  retry.onclick = async () => {
    retry.hidden = true;
    btn.disabled = true;
    tbody.innerHTML = '';
    summary.textContent = '';
    const r = await fetch('/api/send/retry-failed', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' });
    if (r.status === 202) {
      const { jobId } = await r.json();
      attachSSE(jobId);
    } else {
      const body = await r.json().catch(() => ({}));
      summary.textContent = 'Error: ' + (body.error || r.status);
      btn.disabled = false;
    }
  };
}
