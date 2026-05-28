import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { api, type Proxy, type ProxyHealthEntry, type ProxyHealthResponse, type ProxyCheckResponse } from '@/lib/api';
import { errLabel } from '@/lib/error-labels';
import { keyOf } from '@/lib/proxyKey';
import { Trash2, Activity } from 'lucide-react';

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return 'только что';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} сек назад`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`;
  return `${Math.floor(diff / 86_400_000)} дн назад`;
}

type Row = { host: string; port: string; username: string; password: string };

const toRow = (p: Proxy): Row => ({
  host: p.host,
  port: String(p.port ?? ''),
  username: p.username ?? '',
  password: p.password ?? ''
});

const toProxy = (r: Row): Proxy => {
  const out: Proxy = { host: r.host.trim(), port: Number(r.port) };
  if (r.username.trim()) out.username = r.username.trim();
  if (r.password) out.password = r.password;
  return out;
};

function useProxyHealth() {
  const [byKey, setByKey] = useState<Record<string, ProxyHealthEntry>>({});
  const refresh = useCallback(async () => {
    const r = await api.get<ProxyHealthResponse>('/api/proxies/health');
    if (r) setByKey(Object.fromEntries(r.entries.map(e => [e.key, e])));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { byKey, refresh };
}

export default function ProxiesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [bulk, setBulk] = useState('');
  const { byKey: health, refresh: refreshHealth } = useProxyHealth();
  const [checking, setChecking] = useState(false);

  const runCheck = async (indices?: number[]) => {
    if (checking) return;
    setChecking(true);
    try {
      const res = await api.request<ProxyCheckResponse>('POST', '/api/proxies/check', indices ? { indices } : {});
      if (res.ok) {
        const ok = res.data.results.filter(r => r.ok).length;
        const failed = res.data.results.length - ok;
        toast.success(`Проверено: ${ok} ok, ${failed} fail`);
        await refreshHealth();
      } else if (res.err.status === 409) {
        toast.error('Проверка уже идёт');
      } else {
        toast.error(errLabel(res.err.error) || `HTTP ${res.err.status}`);
      }
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    api.get<Proxy[]>('/api/proxies').then(r => { if (r) setRows(r.map(toRow)); });
  }, []);

  const addRow = () => setRows(prev => [...prev, { host: '', port: '', username: '', password: '' }]);
  const removeRow = (i: number) => setRows(prev => prev.filter((_, idx) => idx !== i));
  const updateRow = (i: number, patch: Partial<Row>) =>
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const importBulk = () => {
    const lines = bulk.split('\n').map(l => l.trim()).filter(Boolean);
    const parsed: Row[] = [];
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length < 2) continue;
      parsed.push({ host: parts[0], port: parts[1], username: parts[2] || '', password: parts[3] || '' });
    }
    if (parsed.length === 0) { toast.error('Не удалось распознать ни одной строки'); return; }
    setRows(prev => [...prev, ...parsed]);
    setBulk('');
    toast.success(`Импортировано: ${parsed.length}`);
  };

  const save = async () => {
    const proxies = rows.map(toProxy);
    const res = await api.request<null>('PUT', '/api/proxies', proxies);
    if (res.ok) toast.success('Сохранено');
    else if (res.err.raw && Array.isArray((res.err.raw as { errors?: unknown }).errors)) {
      toast.error('Errors: ' + ((res.err.raw as { errors: string[] }).errors).join('; '));
    } else {
      toast.error(errLabel(res.err.error) || `HTTP ${res.err.status}`);
    }
  };

  return (
    <div className="container mx-auto py-6 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Proxies (SOCKS5)</CardTitle>
          <CardDescription>
            Формат импорта: <code>host:port</code> или <code>host:port:user:pass</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Host</TableHead>
                <TableHead className="w-[100px]">Port</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Pass</TableHead>
                <TableHead className="w-[200px]">Status</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell><Input value={r.host} onChange={e => updateRow(i, { host: e.target.value })} /></TableCell>
                  <TableCell><Input type="number" value={r.port} onChange={e => updateRow(i, { port: e.target.value })} /></TableCell>
                  <TableCell><Input value={r.username} onChange={e => updateRow(i, { username: e.target.value })} /></TableCell>
                  <TableCell><Input value={r.password} onChange={e => updateRow(i, { password: e.target.value })} /></TableCell>
                  <TableCell>
                    {(() => {
                      const key = keyOf({
                        host: r.host.trim(),
                        port: Number(r.port),
                        username: r.username.trim() || undefined,
                        password: r.password || undefined
                      });
                      const entry = health[key];
                      if (!entry) return <span className="text-muted-foreground">—</span>;
                      return (
                        <div className="space-y-0.5">
                          {entry.ok
                            ? <Badge variant="default">✓ {entry.latencyMs}ms</Badge>
                            : <Badge variant="destructive">× {errLabel(entry.error) || entry.error}</Badge>}
                          <div className="text-xs text-muted-foreground">checked {relativeTime(entry.checkedAt)}</div>
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" onClick={() => runCheck([i])} disabled={checking} title="Check">
                        <Activity className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => removeRow(i)} title="Delete">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">пусто</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
          <div className="flex gap-2">
            <Button onClick={addRow} variant="outline">+ Row</Button>
            <Button onClick={save}>Save</Button>
            <Button onClick={() => runCheck()} variant="secondary" disabled={checking}>
              {checking ? 'Проверка…' : 'Check all'}
            </Button>
          </div>
          <div className="space-y-2 pt-4 border-t">
            <Textarea
              value={bulk}
              onChange={e => setBulk(e.target.value)}
              placeholder="Paste lines: host:port or host:port:user:pass"
              rows={6}
            />
            <Button onClick={importBulk} variant="secondary">Import</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
