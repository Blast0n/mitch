import { Card } from '@/components/ui/card';

type Props = {
  elapsedSec: number;
  etaSec: number | null;
  pending: number;
  sending: number;
  ok: number;
  failed: number;
};

export function JobStats({ elapsedSec, etaSec, pending, sending, ok, failed }: Props) {
  return (
    <Card className="px-4 py-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
      <div>Прошло: <strong>{elapsedSec}s</strong></div>
      <div>ETA: <strong>{etaSec == null ? '—' : `${etaSec}s`}</strong></div>
      <div>Pending: <strong>{pending}</strong></div>
      <div>Sending: <strong>{sending}</strong></div>
      <div className="text-emerald-500">OK: <strong>{ok}</strong></div>
      <div className="text-destructive">Failed: <strong>{failed}</strong></div>
    </Card>
  );
}
