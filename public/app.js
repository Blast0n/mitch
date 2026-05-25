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
  const summaryEl = $('#summary');
  const stats = $('#job-stats');
  const elapsedEl = $('#elapsed');
  const etaEl = $('#eta');
  const cntPending = $('#cnt-pending');
  const cntSending = $('#cnt-sending');
  const cntOk = $('#cnt-ok');
  const cntFailed = $('#cnt-failed');
  const logEl = $('#event-log');

  const ERROR_LABELS = {
    token_invalid: 'Токен невалиден или протух',
    proxy_unreachable: 'Прокси не отвечает',
    proxy_auth_failed: 'Прокси: неверный логин/пароль',
    twitch_unreachable: 'Twitch недоступен',
    chat_blocked: 'Аккаунт заблокирован в чате',
    join_failed: 'Не удалось войти в канал',
    timeout: 'Превышено время ожидания (15 сек)',
    unknown: 'Неизвестная ошибка'
  };
  const STAGE_LABELS = {
    connecting: 'подключение',
    auth: 'авторизация',
    join: 'вход в канал',
    sent: 'отправлено',
    waiting: 'подтверждение'
  };
  const errLabel = (code) => code ? (ERROR_LABELS[code] || code) : '';

  function pad(n) { return String(n).padStart(2, '0'); }
  function nowStamp() {
    const d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function logEvent({ text, kind, login }) {
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = '[' + nowStamp() + '] ';
    const who = document.createElement('span');
    who.className = 'log-login';
    who.textContent = login ? login + ' → ' : '';
    const msg = document.createElement('span');
    if (kind === 'ok') msg.className = 'log-ok';
    else if (kind === 'err') msg.className = 'log-err';
    msg.textContent = text;
    const line = document.createElement('div');
    line.append(time, who, msg);
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function clearLog() { logEl.innerHTML = ''; }

  const counts = { pending: 0, sending: 0, ok: 0, failed: 0 };
  function setCount(k, v) { counts[k] = v; const el = { pending: cntPending, sending: cntSending, ok: cntOk, failed: cntFailed }[k]; if (el) el.textContent = v; }
  function resetCounts(total) {
    setCount('pending', total);
    setCount('sending', 0);
    setCount('ok', 0);
    setCount('failed', 0);
  }

  let jobStart = 0, elapsedTimer = null;
  function startElapsed(totalEta) {
    jobStart = Date.now();
    if (totalEta) etaEl.textContent = totalEta + 's';
    elapsedTimer = setInterval(() => {
      elapsedEl.textContent = Math.floor((Date.now() - jobStart) / 1000) + 's';
    }, 250);
  }
  function stopElapsed() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

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
      tr.children[1].className = '';
      tr.children[2].textContent = proxy;
      setCount('pending', Math.max(0, counts.pending - 1));
      setCount('sending', counts.sending + 1);
      logEvent({ login, text: 'старт' + (proxy && proxy !== 'direct' ? ' через ' + proxy : ' (без прокси)') });
    });
    es.addEventListener('stage', (e) => {
      const { login, stage } = JSON.parse(e.data);
      const tr = rowFor(login);
      const label = STAGE_LABELS[stage] || stage;
      tr.children[1].textContent = label;
      logEvent({ login, text: label });
    });
    es.addEventListener('progress', (e) => {
      const { login, proxy, result } = JSON.parse(e.data);
      const tr = rowFor(login);
      tr.children[1].textContent = result.ok ? 'ok' : 'failed';
      tr.children[1].className = result.ok ? 'ok' : 'error';
      tr.children[2].textContent = proxy;
      tr.children[3].textContent = (result.durationMs ?? '—') + 'ms';
      tr.children[4].textContent = errLabel(result.error);
      setCount('sending', Math.max(0, counts.sending - 1));
      if (result.ok) {
        setCount('ok', counts.ok + 1);
        logEvent({ login, text: 'успех (' + result.durationMs + 'ms)', kind: 'ok' });
      } else {
        setCount('failed', counts.failed + 1);
        logEvent({ login, text: 'ошибка: ' + errLabel(result.error), kind: 'err' });
      }
    });
    es.addEventListener('done', (e) => {
      const { summary: s } = JSON.parse(e.data);
      summaryEl.textContent = `Готово: ${s.ok}/${s.total} ok, ${s.failed} failed`;
      btn.disabled = false;
      if (s.failed > 0) retry.hidden = false;
      stopElapsed();
      logEvent({ text: `завершено: ${s.ok}/${s.total} успешно, ${s.failed} с ошибкой`, kind: s.failed === 0 ? 'ok' : 'err' });
      es.close();
    });
  }

  async function startJob(endpoint) {
    btn.disabled = true;
    tbody.innerHTML = '';
    summaryEl.textContent = '';
    retry.hidden = true;
    clearLog();
    stats.hidden = false;
    // Get accounts count + spread for initial counters/ETA
    const [accounts, settings] = await Promise.all([
      fetch('/api/accounts').then(r => r.json()),
      fetch('/api/settings').then(r => r.json())
    ]);
    const total = endpoint.includes('retry-failed') ? counts.failed : accounts.length;
    resetCounts(total);
    startElapsed(settings.spreadSeconds || 0);
    logEvent({ text: `запуск job: ${total} аккаунтов, spread ${settings.spreadSeconds}s, concurrency ${settings.concurrency}` });
    const r = await fetch(endpoint, { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' });
    if (r.status === 202) {
      const { jobId } = await r.json();
      attachSSE(jobId);
    } else if (r.status === 409) {
      const body = await r.json();
      logEvent({ text: 'job уже идёт, подключаемся', kind: 'err' });
      if (body.jobId) attachSSE(body.jobId);
      else { summaryEl.textContent = 'A job is already running.'; btn.disabled = false; stopElapsed(); }
    } else {
      const body = await r.json().catch(() => ({}));
      summaryEl.textContent = 'Error: ' + (body.error || r.status);
      logEvent({ text: 'не удалось запустить: ' + (body.error || r.status), kind: 'err' });
      btn.disabled = false;
      stopElapsed();
    }
  }

  btn.onclick = () => startJob('/api/send');
  retry.onclick = () => startJob('/api/send/retry-failed');
}
