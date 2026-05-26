import { FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, type Settings } from '@/lib/api';
import { errLabel } from '@/lib/error-labels';

const EMPTY: Settings = { channel: '', word: '', accountsPerProxy: 5, spreadSeconds: 0, concurrency: 5 };

export default function SettingsPage() {
  const [s, setS] = useState<Settings>(EMPTY);

  useEffect(() => {
    api.get<Settings>('/api/settings').then(r => { if (r) setS(r); });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Settings = {
      channel: s.channel.trim(),
      word: s.word,
      accountsPerProxy: Number(s.accountsPerProxy),
      spreadSeconds: Number(s.spreadSeconds),
      concurrency: Number(s.concurrency)
    };
    const res = await api.request<null>('PUT', '/api/settings', body);
    if (res.ok) toast.success('Сохранено');
    else if (res.err.raw && Array.isArray((res.err.raw as { errors?: unknown }).errors)) {
      toast.error('Errors: ' + ((res.err.raw as { errors: string[] }).errors).join('; '));
    } else {
      toast.error(errLabel(res.err.error) || `HTTP ${res.err.status}`);
    }
  };

  return (
    <div className="container mx-auto py-6">
      <Card className="max-w-xl">
        <CardHeader><CardTitle>Settings</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="channel">Channel</Label>
              <Input id="channel" value={s.channel} onChange={e => setS({ ...s, channel: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="word">Word</Label>
              <Input id="word" value={s.word} onChange={e => setS({ ...s, word: e.target.value })} required />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="app">Accounts per proxy</Label>
                <Input id="app" type="number" min={1} value={s.accountsPerProxy} onChange={e => setS({ ...s, accountsPerProxy: Number(e.target.value) })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="spread">Spread (sec)</Label>
                <Input id="spread" type="number" min={0} value={s.spreadSeconds} onChange={e => setS({ ...s, spreadSeconds: Number(e.target.value) })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="conc">Concurrency</Label>
                <Input id="conc" type="number" min={1} value={s.concurrency} onChange={e => setS({ ...s, concurrency: Number(e.target.value) })} />
              </div>
            </div>
            <Button type="submit">Save</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
