import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

export type ProgressRow = {
  login: string;
  status: string;
  proxy: string;
  durationMs: number | null;
  error: string;
  kind?: 'ok' | 'err' | 'in-progress';
};

type Props = { rows: ProgressRow[] };

function statusBadge(r: ProgressRow) {
  if (r.kind === 'ok') return <Badge className="bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/15">{r.status}</Badge>;
  if (r.kind === 'err') return <Badge variant="destructive">{r.status}</Badge>;
  if (r.kind === 'in-progress') return <Badge variant="secondary">{r.status}</Badge>;
  return <Badge variant="outline">{r.status}</Badge>;
}

export function ProgressTable({ rows }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Login</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Proxy</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Error</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">нет данных — нажми Send</TableCell></TableRow>
        ) : rows.map((r, i) => (
          <TableRow key={i}>
            <TableCell className="font-medium">{r.login}</TableCell>
            <TableCell>{statusBadge(r)}</TableCell>
            <TableCell className="font-mono text-xs">{r.proxy}</TableCell>
            <TableCell>{r.durationMs == null ? '—' : `${r.durationMs}ms`}</TableCell>
            <TableCell className="text-destructive">{r.error}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
