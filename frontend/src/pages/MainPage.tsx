import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { QuickSend } from '@/components/QuickSend';
import { JobStats } from '@/components/JobStats';
import { EventLog, type LogEntry } from '@/components/EventLog';
import { ProgressTable, type ProgressRow } from '@/components/ProgressTable';
import { api, type Account, type Proxy, type Settings, type JobEvent } from '@/lib/api';
import { errLabel, STAGE_LABELS } from '@/lib/error-labels';
import { useSSE } from '@/hooks/useSSE';

function pad(n: number) { return String(n).padStart(2, '0'); }
function nowStamp() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

type RowMap = Record<string, ProgressRow>;

function deriveRows(events: JobEvent[], allLogins: string[]): { rows: ProgressRow[]; counts: { pending: number; sending: number; ok: number; failed: number }; doneSummary?: { total: number; ok: number; failed: number } } {
  const map: RowMap = {};
  for (const l of allLogins) {
    map[l] = { login: l, status: 'pending', proxy: '—', durationMs: null, error: '' };
  }
  let doneSummary: { total: number; ok: number; failed: number } | undefined;
  for (const e of events) {
    if (e.type === 'sending') {
      const r = map[e.login] || (map[e.login] = { login: e.login, status: 'pending', proxy: '—', durationMs: null, error: '' });
      r.status = 'sending'; r.proxy = e.proxy; r.kind = 'in-progress';
    } else if (e.type === 'stage') {
      const r = map[e.login] || (map[e.login] = { login: e.login, status: 'pending', proxy: '—', durationMs: null, error: '' });
      r.status = STAGE_LABELS[e.stage] ?? e.stage; r.kind = 'in-progress';
    } else if (e.type === 'progress') {
      const r = map[e.login] || (map[e.login] = { login: e.login, status: 'pending', proxy: '—', durationMs: null, error: '' });
      r.proxy = e.proxy;
      r.durationMs = e.result.durationMs;
      if (e.result.ok) { r.status = 'ok'; r.kind = 'ok'; r.error = ''; }
      else { r.status = 'failed'; r.kind = 'err'; r.error = errLabel(e.result.error); }
    } else if (e.type === 'done') {
      doneSummary = e.summary;
    }
  }
  const rows = Object.values(map);
  const counts = { pending: 0, sending: 0, ok: 0, failed: 0 };
  for (const r of rows) {
    if (r.kind === 'ok') counts.ok++;
    else if (r.kind === 'err') counts.failed++;
    else if (r.kind === 'in-progress') counts.sending++;
    else counts.pending++;
  }
  return { rows, counts, doneSummary };
}

type LogAction = { type: 'reset' } | { type: 'add'; entry: Omit<LogEntry, 'ts'> };
function logReducer(state: LogEntry[], action: LogAction): LogEntry[] {
  if (action.type === 'reset') return [];
  return [...state, { ...action.entry, ts: nowStamp() }];
}

export default function MainPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [log, dispatchLog] = useReducer(logReducer, []);
  const events = useSSE(jobId);

  const reload = useCallback(() => {
    Promise.all([
      api.get<Settings>('/api/settings'),
      api.get<Account[]>('/api/accounts'),
      api.get<Proxy[]>('/api/proxies')
    ]).then(([s, a, p]) => {
      if (s) setSettings(s);
      if (a) setAccounts(a);
      if (p) setProxies(p);
    });
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (!startedAt) { setElapsed(0); return; }
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(id);
  }, [startedAt]);

  const isRunning = jobId !== null && !events.some(e => e.type === 'done');

  const expectedLogins = useMemo(() => accounts.map(a => a.login), [accounts]);
  const { rows, counts, doneSummary } = useMemo(() => deriveRows(events, expectedLogins), [events, expectedLogins]);

  // Process only NEW events since last render via a ref counter.
  const processedRef = useRef(0);
  useEffect(() => {
    while (processedRef.current < events.length) {
      const ev = events[processedRef.current];
      if (ev.type === 'sending') {
        dispatchLog({ type: 'add', entry: { login: ev.login, text: 'старт' + (ev.proxy && ev.proxy !== 'direct' ? ' через ' + ev.proxy : ' (без прокси)') } });
      } else if (ev.type === 'stage') {
        dispatchLog({ type: 'add', entry: { login: ev.login, text: STAGE_LABELS[ev.stage] ?? ev.stage } });
      } else if (ev.type === 'progress') {
        dispatchLog({
          type: 'add',
          entry: ev.result.ok
            ? { login: ev.login, text: `успех (${ev.result.durationMs}ms)`, kind: 'ok' }
            : { login: ev.login, text: 'ошибка: ' + errLabel(ev.result.error), kind: 'err' }
        });
      } else if (ev.type === 'done') {
        dispatchLog({ type: 'add', entry: { text: `завершено: ${ev.summary.ok}/${ev.summary.total} успешно, ${ev.summary.failed} с ошибкой`, kind: ev.summary.failed === 0 ? 'ok' : 'err' } });
      }
      processedRef.current++;
    }
  }, [events]);

  const etaSec = settings?.spreadSeconds || null;

  async function startJob(endpoint: string) {
    setJobId(null);
    processedRef.current = 0;
    setStartedAt(Date.now());
    dispatchLog({ type: 'reset' });
    if (settings) {
      dispatchLog({ type: 'add', entry: { text: `запуск job: ${expectedLogins.length} аккаунтов, spread ${settings.spreadSeconds}s, concurrency ${settings.concurrency}` } });
    }
    const res = await api.request<{ jobId: string }>('POST', endpoint);
    if (res.ok && res.data) {
      setJobId(res.data.jobId);
    } else if (!res.ok && res.err.status === 409 && (res.err.raw as { jobId?: string })?.jobId) {
      setJobId(((res.err.raw as { jobId: string }).jobId));
      dispatchLog({ type: 'add', entry: { text: 'job уже идёт, подключаемся', kind: 'err' } });
    } else if (!res.ok) {
      const label = errLabel(res.err.error) || `HTTP ${res.err.status}`;
      toast.error(label);
      dispatchLog({ type: 'add', entry: { text: 'не удалось запустить: ' + label, kind: 'err' } });
      setStartedAt(null);
    }
  }

  return (
    <div className="container mx-auto py-6 space-y-4">
      <QuickSend
        disabled={isRunning}
        onLogEvent={(e) => dispatchLog({ type: 'add', entry: e })}
      />
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base text-muted-foreground">Settings preview</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          <div><span className="text-muted-foreground">Channel:</span> #{settings?.channel || '—'}</div>
          <div><span className="text-muted-foreground">Word:</span> {settings?.word || '—'}</div>
          <div><span className="text-muted-foreground">Accounts:</span> {accounts.length}</div>
          <div><span className="text-muted-foreground">Proxies:</span> {proxies.length} ({settings?.accountsPerProxy ?? '—'}/proxy)</div>
          <div><span className="text-muted-foreground">Spread:</span> {settings?.spreadSeconds ?? '—'}s</div>
          <div><span className="text-muted-foreground">Concurrency:</span> {settings?.concurrency ?? '—'}</div>
          <Link to="/settings" className="col-span-full text-sm underline text-primary">Edit</Link>
        </CardContent>
      </Card>
      <div className="flex gap-2">
        <Button onClick={() => startJob('/api/send')} disabled={isRunning}>Send</Button>
        {doneSummary && doneSummary.failed > 0 && (
          <Button variant="secondary" onClick={() => startJob('/api/send/retry-failed')} disabled={isRunning}>Retry failed</Button>
        )}
      </div>
      {(isRunning || doneSummary || events.length > 0) && (
        <JobStats elapsedSec={elapsed} etaSec={etaSec} pending={counts.pending} sending={counts.sending} ok={counts.ok} failed={counts.failed} />
      )}
      <EventLog entries={log} />
      <ProgressTable rows={rows} />
      {doneSummary && (
        <p className="text-sm text-muted-foreground">
          Готово: {doneSummary.ok}/{doneSummary.total} ok, {doneSummary.failed} failed
        </p>
      )}
    </div>
  );
}
