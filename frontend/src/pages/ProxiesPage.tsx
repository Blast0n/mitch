import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, type Proxy } from '@/lib/api';
import { errLabel } from '@/lib/error-labels';
import { Trash2 } from 'lucide-react';

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

export default function ProxiesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [bulk, setBulk] = useState('');

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
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell><Input value={r.host} onChange={e => updateRow(i, { host: e.target.value })} /></TableCell>
                  <TableCell><Input type="number" value={r.port} onChange={e => updateRow(i, { port: e.target.value })} /></TableCell>
                  <TableCell><Input value={r.username} onChange={e => updateRow(i, { username: e.target.value })} /></TableCell>
                  <TableCell><Input value={r.password} onChange={e => updateRow(i, { password: e.target.value })} /></TableCell>
                  <TableCell><Button size="icon" variant="ghost" onClick={() => removeRow(i)}><Trash2 className="h-4 w-4" /></Button></TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">пусто</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
          <div className="flex gap-2">
            <Button onClick={addRow} variant="outline">+ Row</Button>
            <Button onClick={save}>Save</Button>
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
