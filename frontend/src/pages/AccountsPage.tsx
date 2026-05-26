import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, type Account } from '@/lib/api';
import { errLabel } from '@/lib/error-labels';
import { Trash2 } from 'lucide-react';

const RAW_TOKEN = /^[a-zA-Z0-9_-]{20,}$/;

function parseBulkLine(line: string): Account | null {
  const colon = line.split(':');
  if (colon.length >= 3 && colon[0] && RAW_TOKEN.test(colon[2])) {
    const login = colon[0];
    const tok = colon[2].startsWith('oauth:') ? colon[2] : 'oauth:' + colon[2];
    return { login, oauthToken: tok };
  }
  const ws = line.split(/\s+/, 2);
  if (ws[0] && ws[1]) {
    const tok = ws[1].startsWith('oauth:') ? ws[1] : 'oauth:' + ws[1];
    return { login: ws[0], oauthToken: tok };
  }
  return null;
}

export default function AccountsPage() {
  const [rows, setRows] = useState<Account[]>([]);
  const [bulk, setBulk] = useState('');

  useEffect(() => {
    api.get<Account[]>('/api/accounts').then(r => { if (r) setRows(r); });
  }, []);

  const addRow = () => setRows(prev => [...prev, { login: '', oauthToken: '' }]);
  const removeRow = (i: number) => setRows(prev => prev.filter((_, idx) => idx !== i));
  const updateRow = (i: number, patch: Partial<Account>) =>
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const importBulk = () => {
    const lines = bulk.split('\n').map(l => l.trim()).filter(Boolean);
    const parsed = lines.map(parseBulkLine).filter((x): x is Account => x !== null);
    if (parsed.length === 0) { toast.error('Не удалось распознать ни одной строки'); return; }
    setRows(prev => [...prev, ...parsed]);
    setBulk('');
    toast.success(`Импортировано: ${parsed.length}`);
  };

  const save = async () => {
    const cleaned = rows.map(r => ({ login: r.login.trim(), oauthToken: r.oauthToken.trim() }));
    const res = await api.request<null>('PUT', '/api/accounts', cleaned);
    if (res.ok) {
      toast.success('Сохранено');
      setRows(cleaned);
    } else if (res.err.raw && Array.isArray((res.err.raw as { errors?: unknown }).errors)) {
      toast.error('Errors: ' + ((res.err.raw as { errors: string[] }).errors).join('; '));
    } else {
      toast.error(errLabel(res.err.error) || `HTTP ${res.err.status}`);
    }
  };

  return (
    <div className="container mx-auto py-6 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>
            Форматы импорта: <code>login&#9;oauth:token</code> или combo-list <code>login:pass:token:userid:date</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[30%]">Login</TableHead>
                <TableHead>Token</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell><Input value={r.login} onChange={e => updateRow(i, { login: e.target.value })} /></TableCell>
                  <TableCell><Input value={r.oauthToken} onChange={e => updateRow(i, { oauthToken: e.target.value })} /></TableCell>
                  <TableCell><Button size="icon" variant="ghost" onClick={() => removeRow(i)}><Trash2 className="h-4 w-4" /></Button></TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">пусто</TableCell></TableRow>
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
              placeholder="Paste accounts here (TSV or combo-list format)"
              rows={6}
            />
            <Button onClick={importBulk} variant="secondary">Import</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
