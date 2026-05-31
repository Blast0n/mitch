import { FormEvent, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import { api, type Account, type QuickSendResponse } from '@/lib/api';
import { errLabel } from '@/lib/error-labels';

type Props = {
  disabled: boolean;
  onLogEvent?: (entry: { login?: string; text: string; kind?: 'ok' | 'err' }) => void;
};

export function QuickSend({ disabled, onLogEvent }: Props) {
  const [login, setLogin] = useState('');
  const [message, setMessage] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok?: boolean }>({ text: '' });
  const msgRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<Account[]>('/api/accounts').then(r => { if (r) setAccounts(r); });
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    const lg = login.trim();
    const msg = message;
    if (!lg || !msg.trim()) { setStatus({ text: 'Заполни оба поля', ok: false }); return; }
    setBusy(true);
    setStatus({ text: 'отправка…' });
    const preview = msg.length > 40 ? msg.slice(0, 40) + '…' : msg;
    onLogEvent?.({ login: lg, text: `quick: "${preview}"` });
    const res = await api.request<QuickSendResponse>('POST', '/api/quick-send', { login: lg, message: msg });
    setBusy(false);
    if (res.ok && res.data && res.data.ok) {
      const r = res.data;
      setStatus({ text: `ok (${r.durationMs}ms) через ${r.proxy}`, ok: true });
      onLogEvent?.({ login: lg, text: `ok (${r.durationMs}ms через ${r.proxy})`, kind: 'ok' });
      setMessage('');
      msgRef.current?.focus();
    } else if (res.ok && res.data) {
      const r = res.data;
      const label = errLabel(r.error);
      setStatus({ text: label, ok: false });
      onLogEvent?.({ login: lg, text: 'ошибка: ' + label, kind: 'err' });
    } else if (!res.ok) {
      const label = errLabel(res.err.error) || `HTTP ${res.err.status}`;
      setStatus({ text: label, ok: false });
      onLogEvent?.({ login: lg, text: 'ошибка: ' + label, kind: 'err' });
      if (res.err.status === 409) toast.error(label);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base text-muted-foreground">Quick send</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} autoComplete="off" className="flex gap-2 items-center">
          <Input
            list="qs-accounts"
            placeholder="Логин аккаунта"
            value={login}
            onChange={e => setLogin(e.target.value)}
            disabled={disabled}
            className="w-[200px]"
          />
          <datalist id="qs-accounts">
            {accounts.map(a => <option key={a.login} value={a.login} />)}
          </datalist>
          <Input
            ref={msgRef}
            placeholder="Сообщение"
            value={message}
            onChange={e => setMessage(e.target.value)}
            disabled={disabled}
            className="flex-1"
          />
          <Button type="submit" disabled={disabled || busy} size="icon"><Send className="h-4 w-4" /></Button>
        </form>
        <div className={`mt-2 text-sm min-h-[1.25rem] ${status.ok === true ? 'text-emerald-500' : status.ok === false ? 'text-destructive' : 'text-muted-foreground'}`}>
          {status.text}
        </div>
      </CardContent>
    </Card>
  );
}
