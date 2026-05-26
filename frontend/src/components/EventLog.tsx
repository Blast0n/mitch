import { useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';

export type LogEntry = {
  ts: string;
  login?: string;
  text: string;
  kind?: 'ok' | 'err';
};

type Props = { entries: LogEntry[] };

export function EventLog({ entries }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Event log</CardTitle></CardHeader>
      <CardContent>
        <ScrollArea ref={scrollRef} className="h-60 rounded border bg-muted/30">
          <div className="p-3 font-mono text-xs space-y-0.5">
            {entries.length === 0 ? (
              <div className="text-muted-foreground">пусто</div>
            ) : entries.map((e, i) => (
              <div key={i}>
                <span className="text-muted-foreground">[{e.ts}] </span>
                {e.login && <span className="text-primary">{e.login} → </span>}
                <span className={e.kind === 'ok' ? 'text-emerald-500' : e.kind === 'err' ? 'text-destructive' : ''}>{e.text}</span>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
